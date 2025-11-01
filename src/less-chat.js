/* Copright © 2025 Trent Piepho */

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
        onChange: () => {
            CONFIG.ChatMessage.batchSize = game.settings.get(MODULENAME, "chatRenderedBatch");
        },
    });

    CONFIG.ChatMessage.batchSize = game.settings.get(MODULENAME, "chatRenderedMax");

    const ChatLog = foundry.applications.sidebar.tabs.ChatLog;

    // New methods
    ChatLog.prototype.prune = prune;
    ChatLog.prototype.schedulePrune = schedulePrune;
    ChatLog.prototype.scheduleExpand = scheduleExpand;
    ChatLog.prototype.updateMax = updateMax;

    // Save some existing methods
    ChatLog.prototype.__attachLogListeners = ChatLog.prototype._attachLogListeners;
    ChatLog.prototype.__onClose = ChatLog.prototype._onClose;

    // Replaced existing methods
    ChatLog.prototype.postOne = postOne;
    ChatLog.prototype._postOne = _postOne; // replacement for #postOne
    ChatLog.prototype.renderBatch = renderBatch;
    ChatLog.prototype.deleteMessage = deleteMessage;
    ChatLog.prototype._onScrollLog = _onScrollLog; // replacement for #onScrollLog
    ChatLog.prototype._attachLogListeners = _attachLogListeners;
    ChatLog.prototype._onClose = _onClose;
    ChatLog.prototype.updateMessage = updateMessage;
    ChatLog.prototype._updateMessage = _updateMessage; // replacement for #updateMessage
    ChatLog.prototype._rerenderMessage = _rerenderMessage; // alternative to #rerenderMessage

    // Unfortunately these are private variables so we can't access them in the methods added here.
    // The only solution is to make non-private copies and then replace every method that uses them.
    Object.defineProperty(ChatLog.prototype, "renderingBatch", { value: false, writable: true, enumerable: true });
    Object.defineProperty(ChatLog.prototype, "renderingQueue", {
        get() {
            return this._renderingQueue ?? (this._renderingQueue = new foundry.utils.Semaphore(1));
        },
    });
    Object.defineProperty(ChatLog.prototype, "overflowingDebounce", {
        get() {
            return (
                this._overflowingDebounce ??
                (this._overflowingDebounce = new foundry.utils.debounce(() => {
                    const scroll = this.element.querySelector(".chat-scroll");
                    scroll.classList.toggle("overflowed", scroll.scrollHeight > scroll.offsetHeight);
                }, 100))
            );
        },
    });
    // This replaces a getter to a private variable, so we can set it too
    Object.defineProperty(ChatLog.prototype, "isAtBottom", { value: true, writable: true, enumerable: true });
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

function scheduleExpand(timeout = 250) {
    if (this.expandTimeout) {
        window.clearTimeout(this.expandTimeout);
        this.expandTimeout = null;
    }
    this.expandTimeout = window.setTimeout(() => {
        this.expandTimeout = null;
        this.updateMax();
    }, timeout);
}

async function updateMax() {
    const count = this.element.querySelector(".chat-log").childElementCount;
    const max = game.settings.get(MODULENAME, "chatRenderedMax");
    if (count < max) {
        this.renderBatch(max - count);
    } else if (count > max) {
        this.schedulePrune();
    }
}

function prune() {
    const log = this.element.querySelector(".chat-log");
    if (log?.childElementCount > game.settings.get(MODULENAME, "chatRenderedMax")) {
        if (!this.isAtBottom) {
            // Call back at a better time
            this.schedulePrune(1000);
            return;
        }
        this.renderingQueue.add(async () => {
            const count = log.childElementCount;
            const toRemove = [...log.children].slice(0, count - game.settings.get(MODULENAME, "chatRenderedMax"));
            //console.log(`${MODULENAME}: Unrendering ${toRemove.length} messages`);
            toRemove.forEach((li) => {
                const msg = game.messages.get(li.dataset.messageId);
                if (msg) msg.logged = false;
                log.removeChild(li);
            });
            this._lastId = (() => {
                for (const next of log.children) {
                    // Find first <li> in the <ul> that is NOT in the process of being deleted
                    if (game.messages.get(next.dataset.messageId)?.logged) return next.dataset.messageId;
                }
                return null;
            })();
        });
    }
}

// This is only here to replace #lastId with _lastId
function _onClose(options) {
    this.__onClose(options);
    this._lastId = null;
}

function _attachLogListeners(element, options) {
    // We can't add the listeners ourselves since they are private methods nor can we remove
    // them after they are added, since there is no way to supply the private methods to
    // removeEventListener().
    // So the trick is to call the original _attachLogListeners() with a fake element, which
    // doesn't add the listener if it's scroll handlers.

    const elementWrapper = {
        addEventListener: (e, f, o) => {
            if (e !== "scroll") element.addEventListener(e, f, o);
        },
    };
    element.addEventListener("scroll", this._onScrollLog.bind(this), { passive: true });
    this.__attachLogListeners(elementWrapper, options);
}

// Identical to original, except it uses renderingQueue and not #renderingQueue
async function updateMessage(message, options = {}) {
    return this.renderingQueue.add(this._updateMessage.bind(this), message, options);
}

// Same as #updateMessage, but doesn't use private variables.  Also we can reference it in updateMessage.
async function _updateMessage(message, { notify = false } = {}) {
    const li = this.element.querySelector(`.message[data-message-id="${message.id}"]`);
    if (li) await this._rerenderMessage(message, li);
    // A previously invisible message has become visible to this user.
    else {
        const messages = game.messages.contents;
        const messageIndex = messages.findIndex((m) => m === message);
        let nextMessage;
        for (let i = messageIndex + 1; i < messages.length; i++) {
            if (messages[i].visible) {
                nextMessage = messages[i];
                break;
            }
        }
        await this._postOne(message, { before: nextMessage?.id, notify: false });
    }

    if (!this.isPopout) {
        // Can't access tyhis.#notificationsElement
        const notificationsElement = document.getElementById("chat-notifications");
        const existing = notificationsElement.querySelector(`.message[data-message-id="${message.id}"]`);
        if (existing) await this._rerenderMessage(message, existing, { canDelete: false, canClose: true });
    }

    if (notify) this.notify(message);

    // Update the popout tab
    await this.popout?.updateMessage(message, { notify: false });
    if (this.isPopout) this.setPosition();
    else this.overflowingDebounce();
}

// This is private, so we need this copy to call.
// The original referenced the private method #onHoverNotification, this version avoids that.
async function _rerenderMessage(message, existing, options = {}) {
    const replacement = await this.constructor.renderMessage(message, options);
    const expanded = Array.from(existing.querySelectorAll('[data-action="expandRoll"]')).map((el) =>
        el.classList.contains("expanded"),
    );
    replacement
        .querySelectorAll('[data-action="expandRoll"]')
        .forEach((r, i) => r.classList.toggle("expanded", expanded[i]));
    replacement.hidden = existing.hidden;
    replacement.style.opacity = existing.style.opacity;
    // Instead of replacing the top level LI node, move the children of the new LI into the old one
    // This way, all the event listeners attached to the existing element remain in place.
    // The original code would try to recreate the listeners, which required access to private
    // methods.  It would also fail to copy listeners attached by a module, since it didn't know
    // about them.
    existing.replaceChildren(...replacement.childNodes);
    // Copy the class list of the new li too
    existing.className = replacement.className;
}

function _onScrollLog(event) {
    if (!this.rendered) return;
    if (!this._jumpToBottomElement) this._jumpToBottomElement = this.element.querySelector(".jump-to-bottom");
    // Private var this.#jumpToBottomElement isn't updated.  There is no use of it,
    // except as an unused argument to game.messages.flush().

    const log = event?.currentTarget ?? this.element.querySelector(".chat-scroll");
    // While comparing <= 1 should work, empirical evidence shows that some browsers aren't
    // rounding correctly and a larger epsilon is needed to account for the round off error.
    this.isAtBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 2;
    if (!this.isAtBottom && log.scrollTop < 100) {
        // Close to top, render new messages
        this.renderBatch(CONFIG.ChatMessage.batchSize);
    }
    log.classList.toggle("scrolled", !this.isAtBottom);
    this._jumpToBottomElement.toggleAttribute("hidden", this.isAtBottom);
}

async function postOne(message, options = {}) {
    if (!message.visible) return;
    return this.renderingQueue.add(this._postOne.bind(this), message, options);
}

async function _postOne(message, { before, notify = false } = {}) {
    if (!this.rendered) return;
    message.logged = true;

    // Track internal flags
    if (!this._lastId) this._lastId = message.id; // Ensure that new messages don't result in batched scrolling
    if ((message.whisper || []).includes(game.user.id) && !message.isRoll) {
        // FIXME: This is not used, it needs to be the private property #lastWhisper.
        this._lastWhisper = message;
    }

    // TODO:  Deal with V13 code to re-order messages based on timestamp
    // It's not clear it me this v13 change was a good idea.  It seems more likely to order
    // messages incorrectly due to to clients not having synchronized clocks than to correct
    // an important ordering that was broken by lag.

    // Render the message to the log
    const html = await this.constructor.renderMessage(message);
    const log = this.element.querySelector(".chat-log");

    // Append the message after some other one
    const existing = before ? log.querySelector(`.message[data-message-id="${before}"]`) : null;
    if (existing) existing.insertAdjacentElement("beforebegin", html);
    // Otherwise, append the message to the bottom of the log
    else {
        log.append(html);
        if (this.isAtBottom || message.author._id === game.user._id) this.scrollBottom({ waitImages: true });
    }

    // Post notification
    if (notify) this.notify(message, { existing: html, newMessage: true });

    // Update popout tab
    await this.popout?._postOne(message, { before, notify: false });
    if (this.isPopout) this.setPosition();
    else this.overflowingDebounce();

    this.schedulePrune();
}

async function renderBatch(size) {
    if (this.renderingBatch) return;
    this.renderingBatch = true;
    return this.renderingQueue.add(async () => {
        // This needs to do what ChatLog##doRenderBatch does

        if (!this.rendered) {
            this.renderingBatch = false;
            return;
        }

        const messages = this.collection.contents;

        // Get the index of the last rendered message
        let lastIdx = messages.findIndex((m) => m.id === this._lastId);
        lastIdx = lastIdx > -1 ? lastIdx : messages.length;

        if (lastIdx !== 0) {
            // Get the next batch to render
            const targetIdx = Math.max(lastIdx - size, 0);
            const elements = [];
            for (let i = targetIdx; i < lastIdx; i++) {
                const message = messages[i];
                if (!message.visible) continue;
                message.logged = true;
                try {
                    elements.push(await this.constructor.renderMessage(message));
                } catch (err) {
                    Hooks.onError(`ChatLog##doRenderBatch(${MODULENAME})`, err, {
                        msg: `Chat message ${message.id} failed to render`,
                        log: "error",
                    });
                }
            }

            // Prepend the HTML
            const log = this.element.querySelector(".chat-log");
            if (log.scrollTop === 0) log.scrollTo({ top: 1, behavior: "instant" });
            log.prepend(...elements);
            this._lastId = messages[targetIdx].id;
        }
        this.renderingBatch = false;
        if (!this.isPopout) this.overflowingDebounce();
        this.schedulePrune(5000);
    });
}

function deleteMessage(messageId, { deleteAll = false } = {}) {
    return this.renderingQueue.add(async () => {
        // This duplicates ChatLog##deleteMessage

        if (!this.rendered) return;

        // Get the chat message being removed from the log
        const message = game.messages.get(messageId);
        if (message) message.logged = false;

        // Get the current HTML element for the message
        const li = this.element.querySelector(`.message[data-message-id="${messageId}"]`);
        if (!li) return;

        // Update the last index
        if (deleteAll) {
            this._lastId = null;
        } else if (messageId === this._lastId) {
            this._lastId = (() => {
                let next = li;
                while ((next = next.nextElementSibling)) {
                    // Find next <li> in the <ul> that is NOT in the process of being deleted
                    if (game.messages.get(next.dataset.messageId)?.logged) return next.dataset.messageId;
                }
                return null;
            })();
        }

        // Remove the deleted message
        li.classList.add("deleting");
        li.animate(
            { height: [`${li.getBoundingClientRect().height}px`, "0"] },
            { duration: 100, easing: "ease" },
        ).finished.then(() => {
            li.remove();
            // Maybe add one to the top after deleting one, but don't do it immediately as often new messages will get
            // added shortly afterward.
            this.scheduleExpand();
            this._onScrollLog();
        });

        if (!this.isPopout) {
            // Can't access this.#notificationsElement
            const notificationsElement = document.getElementById("chat-notifications");
            notificationsElement.querySelector(`.message[data-message-id="${messageId}"]`)?.remove();
        }

        // Delete from popout tab
        this.popout?.deleteMessage(messageId, { deleteAll });
        if (this.isPopout) this.setPosition();
        else this.overflowingDebounce();
    });
}
