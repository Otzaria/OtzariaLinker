-- Otzaria user_books.db — the FIRST user_link schema: the source side is a personal book of the same database by id
-- (FK sourceBookId), only the target is named by title + isUserBook flag; no anchors, ranges, origin or db slugs.
-- Source: Otzaria/otzaria lib/migration/database/daos/database.dart @ 65db26bd2 ("קישורים ודורות לספרים אישיים"), copied
-- verbatim (Dart string quotes removed). The app upgrades it in place to user-books.sql's user_link
-- (_ensureUserLinkSchema / _rebuildUserLinkTable, database.dart:248-334 @ a6be90800), but a database written by an older
-- app and never opened by a newer one keeps this layout. Use it instead of user_link of user-books.sql.

CREATE TABLE IF NOT EXISTS user_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceBookId INTEGER NOT NULL,
    sourceLineIndex INTEGER NOT NULL,
    targetTitle TEXT NOT NULL,
    targetCategoryId INTEGER,
    targetIsUserBook INTEGER NOT NULL DEFAULT 0,
    targetRef TEXT,
    targetLineIndex INTEGER,
    connectionType TEXT NOT NULL,
    FOREIGN KEY (sourceBookId) REFERENCES book(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_link_source ON user_link(sourceBookId, sourceLineIndex);
CREATE INDEX IF NOT EXISTS idx_user_link_target ON user_link(targetTitle, targetIsUserBook);
