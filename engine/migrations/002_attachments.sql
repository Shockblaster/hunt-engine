-- Files sent with an email (JSON array of paths inside the workspace folder).
ALTER TABLE messages ADD COLUMN attachments TEXT;
