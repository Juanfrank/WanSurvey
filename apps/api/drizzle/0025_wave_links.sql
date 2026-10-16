-- A web survey wave can be by e-mail (as before) or "links only": a personal link per case,
-- handed out by the project however it wants (SMS, WhatsApp, a letter), with nothing sent.
ALTER TABLE "waves" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;
