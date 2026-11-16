-- Otzaria seforim.db — schema 0 DDL (best-effort reconstruction)
-- Source: Otzaria/SeforimLibrary (fork, branch otzaria) dao/src/commonMain/sqldelight/io/github/kdroidfilter/seforimlibrary/db/Database.sq
--         at eca22651^1 = 753d9134 (2026-04-26 04:44:40 +0000), executed in SQLite and dumped from sqlite_master.
-- Pre-schema_meta (kdroid-era) DB: no schema_meta table, AUTOINCREMENT ids (sqlite_sequence exists), no link_anchor/range. Last Database.sq state before eca22651 (2026-05-12).
-- Tables/indexes are sorted by table name, not creation order. sqlite_autoindex_* and
-- sqlite_stat1/4 (created by ANALYZE in released DBs) are not listed.

CREATE TABLE alt_toc_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    structureId INTEGER NOT NULL,
    parentId INTEGER,
    textId INTEGER NOT NULL,
    level INTEGER NOT NULL,
    lineId INTEGER,
    isLastChild INTEGER NOT NULL DEFAULT 0,
    hasChildren INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (structureId) REFERENCES alt_toc_structure(id) ON DELETE CASCADE,
    FOREIGN KEY (parentId) REFERENCES alt_toc_entry(id) ON DELETE CASCADE,
    FOREIGN KEY (textId) REFERENCES tocText(id) ON DELETE CASCADE,
    FOREIGN KEY (lineId) REFERENCES line(id) ON DELETE SET NULL
);

CREATE INDEX idx_alt_toc_entry_line ON alt_toc_entry(lineId);

CREATE INDEX idx_alt_toc_entry_parent ON alt_toc_entry(parentId);

CREATE INDEX idx_alt_toc_entry_structure ON alt_toc_entry(structureId);

CREATE INDEX idx_alt_toc_entry_text ON alt_toc_entry(textId);

CREATE TABLE alt_toc_structure (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER NOT NULL,
    -- Stable key for the structure (e.g., "Parasha")
    key TEXT NOT NULL,
    title TEXT,
    heTitle TEXT,
    UNIQUE (bookId, key),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE
);

CREATE INDEX idx_alt_toc_structure_book ON alt_toc_structure(bookId);

CREATE INDEX idx_alt_toc_structure_key ON alt_toc_structure(key);

CREATE TABLE author (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_author_name ON author(name);

CREATE TABLE book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoryId INTEGER NOT NULL,
    sourceId INTEGER NOT NULL,
    title TEXT NOT NULL,
    heRef TEXT,
    heShortDesc TEXT,
    -- Optional raw notes attached to the base book (when a companion file 'הערות על <title>' exists)
    notesContent TEXT,
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
    FOREIGN KEY (categoryId) REFERENCES category(id) ON DELETE CASCADE,
    FOREIGN KEY (sourceId) REFERENCES source(id) ON DELETE RESTRICT
);

CREATE INDEX idx_book_category ON book(categoryId);

CREATE INDEX idx_book_heref ON book(heRef);

CREATE INDEX idx_book_order ON book(orderIndex);

CREATE INDEX idx_book_source ON book(sourceId);

CREATE INDEX idx_book_title ON book(title);

CREATE TABLE book_acronym (
    bookId INTEGER NOT NULL,
    term TEXT NOT NULL,
    PRIMARY KEY (bookId, term),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_acronym_term ON book_acronym(term);

CREATE TABLE book_author (
    bookId INTEGER NOT NULL,
    authorId INTEGER NOT NULL,
    PRIMARY KEY (bookId, authorId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (authorId) REFERENCES author(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_author_author ON book_author(authorId);

CREATE INDEX idx_book_author_book ON book_author(bookId);

CREATE TABLE book_has_links (
    bookId INTEGER PRIMARY KEY,
    hasSourceLinks INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
    hasTargetLinks INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_has_source_links ON book_has_links(hasSourceLinks);

CREATE INDEX idx_book_has_target_links ON book_has_links(hasTargetLinks);

CREATE TABLE book_pub_date (
    bookId INTEGER NOT NULL,
    pubDateId INTEGER NOT NULL,
    PRIMARY KEY (bookId, pubDateId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (pubDateId) REFERENCES pub_date(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_pub_date_book ON book_pub_date(bookId);

CREATE INDEX idx_book_pub_date_date ON book_pub_date(pubDateId);

CREATE TABLE book_pub_place (
    bookId INTEGER NOT NULL,
    pubPlaceId INTEGER NOT NULL,
    PRIMARY KEY (bookId, pubPlaceId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (pubPlaceId) REFERENCES pub_place(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_pub_place_book ON book_pub_place(bookId);

CREATE INDEX idx_book_pub_place_place ON book_pub_place(pubPlaceId);

CREATE TABLE book_topic (
    bookId INTEGER NOT NULL,
    topicId INTEGER NOT NULL,
    PRIMARY KEY (bookId, topicId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (topicId) REFERENCES topic(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_topic_book ON book_topic(bookId);

CREATE INDEX idx_book_topic_topic ON book_topic(topicId);

CREATE TABLE category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parentId INTEGER,
    title TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    orderIndex INTEGER NOT NULL DEFAULT 999,
    FOREIGN KEY (parentId) REFERENCES category(id) ON DELETE CASCADE
);

CREATE INDEX idx_category_order ON category(orderIndex);

CREATE INDEX idx_category_parent ON category(parentId);

CREATE TABLE category_closure (
    ancestorId INTEGER NOT NULL,
    descendantId INTEGER NOT NULL,
    PRIMARY KEY (ancestorId, descendantId),
    FOREIGN KEY (ancestorId) REFERENCES category(id) ON DELETE CASCADE,
    FOREIGN KEY (descendantId) REFERENCES category(id) ON DELETE CASCADE
);

CREATE INDEX idx_category_closure_ancestor ON category_closure(ancestorId);

CREATE INDEX idx_category_closure_descendant ON category_closure(descendantId);

CREATE TABLE connection_type (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_connection_type_name ON connection_type(name);

CREATE TABLE default_commentator (
    bookId INTEGER NOT NULL,
    commentatorBookId INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (bookId, commentatorBookId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (commentatorBookId) REFERENCES book(id) ON DELETE CASCADE
);

CREATE INDEX idx_default_commentator_book ON default_commentator(bookId);

CREATE INDEX idx_default_commentator_commentator ON default_commentator(commentatorBookId);

CREATE TABLE default_targum (
    bookId INTEGER NOT NULL,
    targumBookId INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (bookId, targumBookId),
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (targumBookId) REFERENCES book(id) ON DELETE CASCADE
);

CREATE INDEX idx_default_targum_book ON default_targum(bookId);

CREATE INDEX idx_default_targum_target ON default_targum(targumBookId);

CREATE TABLE line (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER NOT NULL,
    lineIndex INTEGER NOT NULL,
    content TEXT NOT NULL,
    heRef TEXT,
    tocEntryId INTEGER,
    -- Visible character count of this line (HTML stripped). Used to compute scrollbar
    -- thumb size from the currently visible lines.
    charCount INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (tocEntryId) REFERENCES tocEntry(id) ON DELETE SET NULL
);

CREATE INDEX idx_line_book_index ON line(bookId, lineIndex);

CREATE INDEX idx_line_heref ON line(heRef);

CREATE INDEX idx_line_toc ON line(tocEntryId);

CREATE TABLE line_alt_toc (
    lineId INTEGER NOT NULL,
    structureId INTEGER NOT NULL,
    altTocEntryId INTEGER NOT NULL,
    PRIMARY KEY (lineId, structureId),
    FOREIGN KEY (lineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (structureId) REFERENCES alt_toc_structure(id) ON DELETE CASCADE,
    FOREIGN KEY (altTocEntryId) REFERENCES alt_toc_entry(id) ON DELETE CASCADE
);

CREATE INDEX idx_line_alt_toc_entry ON line_alt_toc(altTocEntryId);

CREATE INDEX idx_line_alt_toc_structure ON line_alt_toc(structureId);

CREATE TABLE line_toc (
    lineId INTEGER PRIMARY KEY,
    tocEntryId INTEGER NOT NULL,
    FOREIGN KEY (lineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (tocEntryId) REFERENCES tocEntry(id) ON DELETE CASCADE
);

CREATE INDEX idx_linetoc_toc ON line_toc(tocEntryId);

CREATE TABLE link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceBookId INTEGER NOT NULL,
    targetBookId INTEGER NOT NULL,
    sourceLineId INTEGER NOT NULL,
    targetLineId INTEGER NOT NULL,
    targetLineIndex INTEGER NOT NULL,
    connectionTypeId INTEGER NOT NULL,
    FOREIGN KEY (sourceBookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (targetBookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (sourceLineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (targetLineId) REFERENCES line(id) ON DELETE CASCADE,
    FOREIGN KEY (connectionTypeId) REFERENCES connection_type(id) ON DELETE CASCADE
);

CREATE INDEX idx_link_source_book ON link(sourceBookId);

CREATE INDEX idx_link_source_line ON link(sourceLineId);

CREATE INDEX idx_link_target_book ON link(targetBookId);

CREATE INDEX idx_link_target_line ON link(targetLineId);

CREATE INDEX idx_link_type ON link(connectionTypeId);

CREATE INDEX idx_link_type_source_line ON link(connectionTypeId, sourceLineId);

CREATE INDEX idx_link_type_source_order ON link(connectionTypeId, sourceLineId, targetLineIndex);

CREATE TABLE pub_date (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_pub_date_date ON pub_date(date);

CREATE TABLE pub_place (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_pub_place_name ON pub_place(name);

CREATE TABLE source (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_source_name ON source(name);

CREATE TABLE tocEntry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER NOT NULL,
    parentId INTEGER,
    textId INTEGER NOT NULL,
    level INTEGER NOT NULL,
    lineId INTEGER,
    isLastChild INTEGER NOT NULL DEFAULT 0,
    hasChildren INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (bookId) REFERENCES book(id) ON DELETE CASCADE,
    FOREIGN KEY (parentId) REFERENCES tocEntry(id) ON DELETE CASCADE,
    FOREIGN KEY (textId) REFERENCES tocText(id) ON DELETE CASCADE,
    FOREIGN KEY (lineId) REFERENCES line(id) ON DELETE SET NULL
);

CREATE INDEX idx_toc_book ON tocEntry(bookId);

CREATE INDEX idx_toc_line ON tocEntry(lineId);

CREATE INDEX idx_toc_parent ON tocEntry(parentId);

CREATE INDEX idx_toc_text_id ON tocEntry(textId);

CREATE INDEX idx_tocentry_level_book ON tocEntry(level, bookId);

CREATE INDEX idx_tocentry_text_level ON tocEntry(textId, level);

CREATE TABLE tocText (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_toc_text ON tocText(text);

CREATE INDEX idx_toctext_text_length ON tocText(text, length(text));

CREATE TABLE topic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_topic_name ON topic(name);
