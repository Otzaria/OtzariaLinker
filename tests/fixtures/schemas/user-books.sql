-- Otzaria user_books.db — the tables the user_link reader needs, copied verbatim (Dart string quotes removed)
-- Source: Otzaria/otzaria lib/migration/database/daos/database.dart @ a6be90800 (_getCreateScripts):
--   category :424-434, source :507-512, book :516-549, line :605-618, connection_type :668-673, link :726-745,
--   user_link :881-906 (the current, cross-database schema: each side by title + isUserBook flag + optional db slug).
-- user_books.db holds the WHOLE script (the same MyDatabase as seforim.db's old layout, database.dart:192-215);
-- only the tables the reader touches are here. The old user_link (sourceBookId) is user-books-user-link-v1.sql.

CREATE TABLE IF NOT EXISTS category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parentId INTEGER,
    title TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    orderIndex INTEGER NOT NULL DEFAULT 999,
    FOREIGN KEY (parentId) REFERENCES category(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_category_parent ON category(parentId);
CREATE INDEX IF NOT EXISTS idx_category_order ON category(orderIndex);

CREATE TABLE IF NOT EXISTS source (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_source_name ON source(name);

CREATE TABLE IF NOT EXISTS book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoryId INTEGER NOT NULL,
    sourceId INTEGER NOT NULL,
    title TEXT NOT NULL,
    heShortDesc TEXT,
    orderIndex INTEGER NOT NULL DEFAULT 999,
    totalLines INTEGER NOT NULL DEFAULT 0,
    isBaseBook INTEGER NOT NULL DEFAULT 0,
    hasTargumConnection INTEGER NOT NULL DEFAULT 0,
    hasReferenceConnection INTEGER NOT NULL DEFAULT 0,
    hasSourceConnection INTEGER NOT NULL DEFAULT 0,
    hasCommentaryConnection INTEGER NOT NULL DEFAULT 0,
    hasOtherConnection INTEGER NOT NULL DEFAULT 0,
    hasAltStructures INTEGER NOT NULL DEFAULT 0,
    hasTeamim INTEGER NOT NULL DEFAULT 0,
    hasNekudot INTEGER NOT NULL DEFAULT 0,
    isContentExternal INTEGER DEFAULT 0,
    externalLibraryId TEXT DEFAULT NULL,
    isPersonal INTEGER DEFAULT 0,
    filePath TEXT DEFAULT NULL,
    fileType TEXT DEFAULT 'txt',
    fileSize INTEGER DEFAULT NULL,
    lastModified INTEGER DEFAULT NULL,
    pages INTEGER DEFAULT NULL,
    volume TEXT DEFAULT NULL,
    FOREIGN KEY (categoryId) REFERENCES category(id) ON DELETE CASCADE,
    FOREIGN KEY (sourceId) REFERENCES source(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_book_category ON book(categoryId);
CREATE INDEX IF NOT EXISTS idx_book_title ON book(title);
CREATE INDEX IF NOT EXISTS idx_book_order ON book(orderIndex);
CREATE INDEX IF NOT EXISTS idx_book_source ON book(sourceId);

CREATE TABLE IF NOT EXISTS line (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER NOT NULL,
    lineIndex INTEGER NOT NULL,
    content TEXT NOT NULL,
    heRef TEXT,
    tocEntryId INTEGER,
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (tocEntryId) REFERENCES tocEntry(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_line_book_index ON line(bookId, lineIndex);
CREATE INDEX IF NOT EXISTS idx_line_toc ON line(tocEntryId);
CREATE INDEX IF NOT EXISTS idx_line_heref ON line(heRef);

CREATE TABLE IF NOT EXISTS connection_type (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_connection_type_name ON connection_type(name);

CREATE TABLE IF NOT EXISTS link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceBookId INTEGER NOT NULL,
    targetBookId INTEGER NOT NULL,
    sourceLineId INTEGER NOT NULL,
    targetLineId INTEGER NOT NULL,
    connectionTypeId INTEGER NOT NULL,
    FOREIGN KEY (sourceBookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (targetBookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (sourceLineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (targetLineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (connectionTypeId) REFERENCES connection_type(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_link_source_book ON link(sourceBookId);
CREATE INDEX IF NOT EXISTS idx_link_source_line ON link(sourceLineId);
CREATE INDEX IF NOT EXISTS idx_link_target_book ON link(targetBookId);
CREATE INDEX IF NOT EXISTS idx_link_target_line ON link(targetLineId);
CREATE INDEX IF NOT EXISTS idx_link_type ON link(connectionTypeId);
CREATE INDEX IF NOT EXISTS idx_link_type_source_line ON link(connectionTypeId, sourceLineId);

CREATE TABLE IF NOT EXISTS user_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceTitle TEXT NOT NULL,
    sourceCategoryId INTEGER,
    sourceIsUserBook INTEGER NOT NULL DEFAULT 0,
    sourceLineIndex INTEGER NOT NULL,
    targetTitle TEXT NOT NULL,
    targetCategoryId INTEGER,
    targetIsUserBook INTEGER NOT NULL DEFAULT 0,
    targetRef TEXT,
    targetLineIndex INTEGER,
    anchorStart INTEGER,
    anchorEnd INTEGER,
    anchorLabel TEXT,
    sourceLineIndexEnd INTEGER,
    targetLineIndexEnd INTEGER,
    targetRefEnd TEXT,
    connectionType TEXT NOT NULL,
    source TEXT,
    sourceDb TEXT,
    targetDb TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_link_source_line ON user_link(sourceTitle, sourceIsUserBook, sourceLineIndex);
CREATE INDEX IF NOT EXISTS idx_user_link_origin ON user_link(source);
CREATE INDEX IF NOT EXISTS idx_user_link_target_line ON user_link(targetTitle, targetIsUserBook, targetLineIndex);
