const { App, LogLevel, Assistant } = require('@slack/bolt');
const { config } = require('dotenv');
const { OpenAI } = require('openai');

config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

/** OpenAI Setup */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Load the assistant ID from the environment variables
const assistantId = process.env.OPENAI_ASSISTANT_ID;

if (!assistantId) {
  console.error('OPENAI_ASSISTANT_ID is not set in .env file.');
  process.exit(1);
}

const DEFAULT_SYSTEM_CONTENT = `You're an assistant in a Slack workspace.
Users in the workspace will ask you to help them write something or to think better about a specific topic.
You'll respond to those questions in a professional way.
When you include markdown text, convert them to Slack compatible ones.
When a prompt has Slack's special syntax like <@USER_ID> or <#CHANNEL_ID>, you must keep them as-is in your response.`;

const assistant = new Assistant({
  /**
   * (Recommended) A custom ThreadContextStore can be provided, inclusive of methods to
   * get and save thread context. When provided, these methods will override the `getThreadContext`
   * and `saveThreadContext` utilities that are made available in other Assistant event listeners.
   */
  // threadContextStore: {
  //   get: async ({ context, client, payload }) => {},
  //   save: async ({ context, client, payload }) => {},
  // },

  /**
   * `assistant_thread_started` is sent when a user opens the Assistant container.
   * This can happen via DM with the app or as a side-container within a channel.
   * https://api.slack.com/events/assistant_thread_started
   */
  threadStarted: async ({ event, logger, say, setSuggestedPrompts, saveThreadContext }) => {
    const { context } = event.assistant_thread;

    try {
      // Since context is not sent along with individual user messages, it's necessary to keep
      // track of the context of the conversation to better assist the user. Sending an initial
      // message to the user with context metadata facilitates this, and allows us to update it
      // whenever the user changes context (via the `assistant_thread_context_changed` event).
      // The `say` utility sends this metadata along automatically behind the scenes.
      // !! Please note: this is only intended for development and demonstrative purposes.
      await say('Hi, how can I help?');

      await saveThreadContext();

      const prompts = [
        {
          title: 'This is a suggested prompt',
          message:
            'When a user clicks a prompt, the resulting prompt message text can be passed ' +
            'directly to your LLM for processing.\n\nAssistant, please create some helpful prompts ' +
            'I can provide to my users.',
        },
      ];

      // If the user opens the Assistant container in a channel, additional
      // context is available.This can be used to provide conditional prompts
      // that only make sense to appear in that context (like summarizing a channel).
      if (context.channel_id) {
        prompts.push({
          title: 'Summarize channel',
          message: 'Assistant, please summarize the activity in this channel!',
        });
      }

      /**
       * Provide the user up to 4 optional, preset prompts to choose from.
       * The optional `title` prop serves as a label above the prompts. If
       * not, provided, 'Try these prompts:' will be displayed.
       * https://api.slack.com/methods/assistant.threads.setSuggestedPrompts
       */
      await setSuggestedPrompts({ prompts, title: 'Here are some suggested options:' });
    } catch (e) {
      logger.error(e);
    }
  },

  /**
   * `assistant_thread_context_changed` is sent when a user switches channels
   * while the Assistant container is open. If `threadContextChanged` is not
   * provided, context will be saved using the AssistantContextStore's `save`
   * method (either the DefaultAssistantContextStore or custom, if provided).
   * https://api.slack.com/events/assistant_thread_context_changed
   */
  threadContextChanged: async ({ logger, saveThreadContext }) => {
    // const { channel_id, thread_ts, context: assistantContext } = event.assistant_thread;
    try {
      await saveThreadContext();
    } catch (e) {
      logger.error(e);
    }
  },

  /**
   * Messages sent to the Assistant do not contain a subtype and must
   * be deduced based on their shape and metadata (if provided).
   * https://api.slack.com/events/message
   */
  userMessage: async ({ client, logger, message, getThreadContext, say, setTitle, setStatus, event }) => {
    const { channel, thread_ts } = message;

    try {
      /**
       * Set the title of the Assistant thread to capture the initial topic/question
       * as a way to facilitate future reference by the user.
       */
      await setTitle(message.text);

      /**
       * Set the status of the Assistant to give the appearance of active processing.
       * https://api.slack.com/methods/assistant.threads.setStatus
       */
      await setStatus('is typing..');

      // **REMOVED: Summarize Channel Prompt**
      //The summarize channel prompt is not compatible with the Assistants API.

      // 1. Get or Create a Thread
      let threadId;
      const threadContext = await getThreadContext();

      if (threadContext.openai_thread_id) {
        // Use existing thread
        threadId = threadContext.openai_thread_id;
      } else {
        // Create a new thread
        const thread = await openai.beta.threads.create();
        threadId = thread.id;

        // Save the thread ID to the context
        if (event.assistant_thread || (message.channel_type === 'im' && message.thread_ts)) {
          if (event.assistant_thread) {
            await event.assistant_thread.saveThreadContext({ openai_thread_id: threadId });
          } else {
            // We're in a DM thread, but event.assistant_thread is missing.
            // This *shouldn't* happen, but log it just in case.
            logger.warn('event.assistant_thread is undefined in DM thread, but proceeding.');
            //In this case, we need to get the thread context some other way.
            //I'm not sure how to do that yet.
          }
        } else {
          logger.warn('event.assistant_thread is undefined.  Could not save thread context.');
          logger.debug(`Event details: ${JSON.stringify(event)}`); // Add this line
        }
      }

      // 2. Add the user's message to the thread
      await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: message.text,
      });

      // 3. Run the assistant
      if (event.assistant_thread || (message.channel_type === 'im' && message.thread_ts)) {
        if (event.assistant_thread) {
          await event.assistant_thread.saveThreadContext({ openai_thread_id: threadId });
        } else {
          // We're in a DM thread, but event.assistant_thread is missing.
          // This *shouldn't* happen, but log it just in case.
          logger.warn('event.assistant_thread is undefined in DM thread, but proceeding.');
          //In this case, we need to get the thread context some other way.
          //I'm not sure how to do that yet.
        }
      } else {
        logger.warn('event.assistant_thread is undefined.  Could not save thread context.');
        logger.debug(`Event details: ${JSON.stringify(event)}`); // Add this line
      }
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
      });

      // 4. Periodically check the run status until it's completed
      let runStatus = run.status;
      while (runStatus !== 'completed' && runStatus !== 'failed' && runStatus !== 'cancelled') {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
        const updatedRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
        runStatus = updatedRun.status;
      }

      if (runStatus === 'completed') {
        // 5. Retrieve the assistant's messages
        const messages = await openai.beta.threads.messages.list(threadId, { order: 'asc' });

        // Extract the assistant's response (the last message)
        const assistantMessage = messages.data
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content[0].text.value)
          .join('\n'); //join in case of multiple messages

        // Provide a response to the user
        await say({ text: assistantMessage });
      } else {
        logger.error(`Run failed with status: ${runStatus}`);
        await say({ text: 'Sorry, the assistant run failed.' });
      }
    } catch (e) {
      logger.error(e);

      // Send message to advise user and clear processing status if a failure occurs
      await say({ text: 'Sorry, something went wrong!' });
    }
  },
});

app.assistant(assistant);

/** Start the Bolt App */
(async () => {
  try {
    await app.start();
    app.logger.info('⚡️ Bolt app is running!');
  } catch (error) {
    app.logger.error('Failed to start the app', error);
  }
})();