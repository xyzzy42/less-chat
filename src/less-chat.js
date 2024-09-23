const MODULENAME = "less-chat";

Hooks.once("init", () => {
    console.info(`${MODULENAME} | Initializing`);

    game.settings.register(MODULENAME, "chatRenderedMax", {
        name: game.i18n.localize(`${MODULENAME}.Settings.Max.name`),
        hint: game.i18n.localize(`${MODULENAME}.Settings.Max.hint`),
        scope: "client",
        config: true,
        requiresReload: false,
        type: Number,
        default: 50,
        onChange: () => {
            ui.chat.updateMax();
        },
    });
    game.settings.register(MODULENAME, "chatRenderedBatch", {
        name: game.i18n.localize(`${MODULENAME}.Settings.Batch.name`),
        hint: game.i18n.localize(`${MODULENAME}.Settings.Batch.hint`),
        scope: "client",
        config: true,
        requiresReload: false,
        type: Number,
        default: 20,
    });

    CONFIG.ChatMessage.batchSize = game.settings.get(MODULENAME, "chatRenderedMax");

    // New methods
    ChatLog.prototype.prune = prune;
    ChatLog.prototype.schedulePrune = schedulePrune;
    ChatLog.prototype.updateMax = updateMax;

    // Replaced existing methods
    ChatLog.prototype.postOne = postOne;
    ChatLog.prototype._renderBatch = _renderBatch;
    ChatLog.prototype.deleteMessage = deleteMessage;
    ChatLog.prototype._onScrollLog = _onScrollLog;

    // Unfortunately these are private variables so we can't access them in the methods added here.
    // The only solution is to make non-private copies and then replace every method that uses them.
    Object.defineProperty(ChatLog.prototype, "renderingQueue", { value: new foundry.utils.Semaphore(1) });
    Object.defineProperty(ChatLog.prototype, "renderingBatch", { value: false, writable: true });

    // This replaces a getter to a private variable, so we can set it too
    Object.defineProperty(ChatLog.prototype, "isAtBottom", { value: true, writable: true });
});

Hooks.once("ready", () => {
    CONFIG.ChatMessage.batchSize = game.settings.get(MODULENAME, "chatRenderedBatch");
});

function schedulePrune(timeout = 250) {
    if (this.pruneTimeout) {
        window.clearTimeout(this.pruneTimeout);
        this.pruneTimeout = null;
    }
    this.pruneTimeout = window.setTimeout(() => {
        this.pruneTimeout = null;
        this.prune();
    }, timeout);
}

async function updateMax() {
    const count = this.element.find("#chat-log")[0].childElementCount;
    const max = game.settings.get(MODULENAME, "chatRenderedMax");
    if (count < max) {
        this._renderBatch(this.element, max - count);
    } else if (count > max) {
        this.schedulePrune();
    }
}

function prune() {
    const msgList = this.element.find("#chat-log");
    if (msgList[0].childElementCount > game.settings.get(MODULENAME, "chatRenderedMax")) {
        if (!this.isAtBottom) {
            // Call back at a better time
            this.schedulePrune(1000);
            return;
        }
        this.renderingQueue.add(async () => {
            const count = msgList[0].childElementCount;
            const toRemove = msgList.children().slice(0, count - game.settings.get(MODULENAME, "chatRenderedMax"));
            // console.log(`${MODULENAME}: Unrendering ${toRemove.length} messages`);
            toRemove.each((i, li) => {
                const msg = game.messages.get(li.dataset.messageId);
                if (msg) msg.logged = false;
            });
            toRemove.remove();
            this._lastId = msgList[0].firstChild?.dataset.messageId || null;
        });
    }
}

function _onScrollLog(event) {
    if (!this.rendered) return;
    if (!this._jumpToBottomElement) this._jumpToBottomElement = this.element.find(".jump-to-bottom")[0];
    // Private var this.#jumpToBottomElement isn't updated.  There is no use of it,
    // except as an unused argument to game.messages.flush().

    const log = event.target;
    this.isAtBottom = log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
    if (!this.isAtBottom && log.scrollTop < 100) {
        // Close to top, render new messages
        this._renderBatch(this.element, CONFIG.ChatMessage.batchSize);
    }
    this._jumpToBottomElement.classList.toggle("hidden", this.isAtBottom);
}

async function postOne(message, { before, notify = false } = {}) {
    if (!message.visible) return;
    return this.renderingQueue.add(async () => {
        message.logged = true;

        // Track internal flags
        if (!this._lastId) this._lastId = message.id; // Ensure that new messages don't result in batched scrolling
        if ((message.whisper || []).includes(game.user.id) && !message.isRoll) {
            this._lastWhisper = message;
        }

        // Render the message to the log
        const html = await message.getHTML();
        const log = this.element.find("#chat-log");

        // Append the message after some other one
        const existing = before ? this.element.find(`.message[data-message-id="${before}"]`) : [];
        if (existing.length) existing.before(html);
        // Otherwise, append the message to the bottom of the log
        else {
            log.append(html);
            if (this.isAtBottom || message.author._id === game.user._id) this.scrollBottom({ waitImages: true });
        }

        // Post notification
        if (notify) this.notify(message);

        // Update popout tab
        if (this._popout) await this._popout.postOne(message, { before, notify: false });
        if (this.popOut) this.setPosition();
        this.schedulePrune();
    });
}

async function _renderBatch(html, size) {
    if (this.renderingBatch) return;
    this.renderingBatch = true;
    return this.renderingQueue.add(async () => {
        const messages = this.collection.contents;

        // Get the index of the last rendered message
        let lastIdx = messages.findIndex((m) => m.id === this._lastId);
        lastIdx = lastIdx !== -1 ? lastIdx : messages.length;

        if (lastIdx !== 0) {
            // Get the next batch to render
            let targetIdx = Math.max(lastIdx - size, 0);
            let m = null;
            let msgs = [];
            for (let i = targetIdx; i < lastIdx; i++) {
                m = messages[i];
                if (!m.visible) continue;
                m.logged = true;
                try {
                    msgs.push(await m.getHTML());
                } catch (err) {
                    err.message = `Chat message ${m.id} failed to render: ${err})`;
                    console.error(err);
                }
            }

            // Prepend the HTML
            html.find("#chat-log, #chat-log-popout").prepend(msgs);
            this._lastId = messages[targetIdx].id;
            this.renderingBatch = false;
            this.schedulePrune(5000);
        }
    });
}

function deleteMessage(messageId, { deleteAll = false } = {}) {
    return this.renderingQueue.add(async () => {
        // Get the chat message being removed from the log
        const message = game.messages.get(messageId, { strict: false });
        if (message) message.logged = false;

        // Get the current HTML element for the message
        let li = this.element.find(`.message[data-message-id="${messageId}"]`);
        if (!li.length) return;

        // Update the last index
        if (deleteAll) {
            this._lastId = null;
        } else if (messageId === this._lastId) {
            const next = li[0].nextElementSibling;
            this._lastId = next ? next.dataset.messageId : null;
        }

        // Remove the deleted message
        li.slideUp(100, () => li.remove());

        // Delete from popout tab
        if (this._popout) this._popout.deleteMessage(messageId, { deleteAll });
        if (this.popOut) this.setPosition();
    });
}
