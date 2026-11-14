-- An approval covers one exact version of an item: recipient, words and files.
ALTER TABLE approvals ADD COLUMN content_hash TEXT;
