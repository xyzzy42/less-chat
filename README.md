# Less Chat

This module will prune the chat log so that not as many chat messages
are rendered in it at once.  This improves performance, as the chat log
can become larger, with more elements, than the rest of the app put together.

*It does not delete the messages.*

You can scroll back and see them, just like normal.  When you get to the top of
the chat scroll bar, there is brief pause while old messages are rendered, and
then you can scroll up more.

Upon scrolling back to the bottom the extra messages are removed.  They are also
continuously removed as new ones are added during play.  This way the rendered
log never gets that big, even after several combats.

But again, the messages are not deleted, this just limits how many messages are
in the chat log scrolling window at one time during normal use.

The settings for the module allows the number of messages kept rendered in the
log to be configured.  The Foundry default is 100.  And the number rendered in
each batch when the log is scrolled to the top can be changed too.
