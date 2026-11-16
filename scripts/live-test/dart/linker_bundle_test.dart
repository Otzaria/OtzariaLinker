// OtzariaLinker stage 20, app-code level: the tool's REAL exported files (the live-test bundle,
// OtzariaLinker scripts/live-test/bundle.ts) through Otzaria's own personal-import, loading and
// display code, against a tiny REAL slice of seforim.db (OtzariaLinker
// scripts/live-test/make-app-slice.py). Not part of Otzaria: kept in OtzariaLinker under
// scripts/live-test/dart/ and copied into a detached Otzaria worktree to run (recipe:
// docs/LIVE_TESTING.md §7). Verified on Otzaria upstream/dev 36dad5bcd (2026-11-16).
//
//   OTZ_LINKER_BUNDLE   the bundle folder (node scripts/live-test/make-bundle.mjs <dir>)
//   OTZ_LINKER_SLICE    the official slice (בראשית lines 0-11, רש"י על בראשית lines 0-7)
//   OTZ_LINKER_ATTACHED the personal-database slice (renamed book 8441 + בראשית)
//   OTZ_LINKER_OUT      optional: where to write what the app did, as JSON
//
// What runs is the app's code end to end, without the UI: the folder scan that registers the books
// and applies the links files (DatabaseLibraryProvider.scanAndAddExternalBooksFromFolder →
// UserSidecarSync → UserContentImporter), the Settings import (UserImportLibrary.addFiles), the
// loading of user links for a book (loadUserLinksForBook / loadUserCommentatorTitles, which
// TextBookRepository merges into the reader), the commentary panel filter (getLinksforIndexs), the
// links panel filter (computeVisibleLinks), anchor injection (injectLinkAnchorMarkers), the numbered
// note markers (numberedNoteLinks / addNumberedNoteMarkerLinks / numberedNoteLinkFromUrl) and the
// link's target text (Link.content, what the preview and "open" show).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:otzaria/book_common/utils/link_anchor_markers.dart';
import 'package:otzaria/core/app_paths.dart';
import 'package:otzaria/data/data_providers/database_library_provider.dart';
import 'package:otzaria/data/data_providers/file_system_library_provider.dart';
import 'package:otzaria/data/data_providers/library_provider_manager.dart';
import 'package:otzaria/data/data_providers/user_books_database_holder.dart';
import 'package:otzaria/migration/database/daos/database.dart';
import 'package:otzaria/migration/database/repository/seforim_repository.dart';
import 'package:otzaria/models/book_source.dart';
import 'package:otzaria/models/link_types.dart';
import 'package:otzaria/models/links.dart';
import 'package:otzaria/settings/engine/app_settings_store.dart';
import 'package:otzaria/settings/engine/settings_repository.dart';
import 'package:otzaria/text_book/utils/link_processing.dart';
import 'package:otzaria/text_book/utils/numbered_note_markers.dart';
import 'package:otzaria/user_content_import/repository/user_content_repository.dart';
import 'package:otzaria/user_content_import/services/user_content_importer.dart';
import 'package:otzaria/user_content_import/services/user_import_library.dart';
import 'package:otzaria/user_content_import/services/user_links_loader.dart';
import 'package:otzaria/user_content_import/services/user_sidecar_sync.dart';
import 'package:path/path.dart' as p;

import '../test_helpers/memory_cache_provider.dart';

const base = 'בדיקת מקשר - ספר בסיס';
const commentary = 'בדיקת מקשר - פירוש';
const notes = 'הערות לבדיקת מקשר';
const citing = 'בדיקת מקשר - ספר מצטט';
const onGenesis = 'בדיקת מקשר - פירוש על בראשית';
const genesis = 'בראשית';
const rashi = 'רש"י על בראשית';
const personalDb = 'בדיקת מקשר - ספר ממסד אישי';
const booksDir = 'בדיקת מקשר';
const slug = 'linker-test';

final env = Platform.environment;
final bundlePath = env['OTZ_LINKER_BUNDLE'];
final slicePath = env['OTZ_LINKER_SLICE'];
final attachedPath = env['OTZ_LINKER_ATTACHED'];

/// What the app did, per case — written to OTZ_LINKER_OUT for the record.
final observed = <String, Object?>{};

late Directory temp;
late Directory folder;
late SeforimRepository userRepo;
late MyDatabase officialDb;

/// Where a book lives in the app: (source, categoryId, file path).
final books = <String, ({BookSource source, int? categoryId, String? filePath, String? fileType})>{};

Future<void> registerBooks() async {
  for (final b in await userRepo.getAllBooksLean()) {
    books[b.title] = (source: BookSource.user, categoryId: b.categoryId, filePath: b.filePath, fileType: b.fileType);
  }
  final g = (await officialDb.database).select('SELECT id, categoryId FROM book WHERE title = ?', [genesis]).single;
  books[genesis] = (source: BookSource.official, categoryId: g['categoryId'] as int, filePath: null, fileType: null);
}

/// The user links the reader merges for [title] (TextBookRepository.getBookLinksInRange).
Future<List<Link>> linksOf(String title, {BookSource? source}) {
  final b = books[title]!;
  return loadUserLinksForBook(
    bookTitle: title,
    bookCategoryId: b.categoryId,
    source: source ?? b.source,
    startLineIndex: 0,
    endLineIndex: 5000,
  );
}

Future<List<String>> commentatorsOf(String title, {BookSource? source}) {
  final b = books[title]!;
  return loadUserCommentatorTitles(bookTitle: title, bookCategoryId: b.categoryId, source: source ?? b.source);
}

String show(Link l) =>
    '${l.path2}:${l.index2}${l.index2End != null && l.index2End != l.index2 ? '-${l.index2End}' : ''}'
    ' ${l.connectionType}${l.targetSource == BookSource.user ? '' : ' [${l.targetSource.wireKey}]'}';

/// What a reader of [title] sees on line [line1] (1-based): the commentary panel (with the
/// book's user commentators selected) and the links panel.
Future<({List<String> commentaries, List<String> linksPanel, List<Link> all})> panelsAt(
  String title,
  int line1, {
  BookSource? source,
}) async {
  final links = await linksOf(title, source: source);
  final commentators = await commentatorsOf(title, source: source);
  final byLine = buildLinksByLineMap(links);
  final commentaries = await getLinksforIndexs(indexes: [line1 - 1], links: links, commentatorsToShow: commentators);
  final panel = computeVisibleLinks(
    links: links,
    visibleIndices: [line1 - 1],
    selectedIndices: {line1 - 1},
    linksByLine: byLine,
  );
  return (
    commentaries: commentaries.map(show).toList(),
    linksPanel: panel.map(show).toList(),
    all: byLine[line1] ?? const <Link>[],
  );
}

/// The book's lines as the app reads a personal text book.
Future<List<String>> linesOf(String title) async {
  final b = books[title]!;
  final errors = <String>[];
  final lines = await UserSidecarSync.readBookLines(
    filePath: b.filePath!,
    fileType: b.fileType,
    title: title,
    errors: errors,
    errorPrefix: title,
  );
  expect(errors, isEmpty);
  return lines!;
}

Future<List<Map<String, Object?>>> userLinkRows() async {
  final db = await userRepo.database.database;
  return db
      .select(
        'SELECT sourceTitle, sourceIsUserBook, sourceDb, sourceLineIndex, sourceLineIndexEnd, '
        'targetTitle, targetIsUserBook, targetDb, targetLineIndex, targetLineIndexEnd, '
        'connectionType, anchorStart, anchorEnd, anchorLabel, targetRef, source '
        'FROM user_link ORDER BY id',
      )
      .map((r) => {for (final k in r.keys) k: r[k]})
      .toList();
}

String rowKey(Map<String, Object?> r) {
  String side(String t, Object? user, Object? db, Object? i, Object? e) =>
      '$t${user == 1 ? '' : db == null ? ' (רשמי)' : ' ($db)'}:${(i as int) + 1}${e == null || e == i ? '' : '-${(e as int) + 1}'}';
  final anchor = r['anchorStart'] == null ? '' : ' @${r['anchorStart']}${r['anchorEnd'] == null ? '' : '-${r['anchorEnd']}'}';
  final label = r['anchorLabel'] == null ? '' : ' "${r['anchorLabel']}"';
  return '${side(r['sourceTitle'] as String, r['sourceIsUserBook'], r['sourceDb'], r['sourceLineIndex'], r['sourceLineIndexEnd'])}'
      ' → ${side(r['targetTitle'] as String, r['targetIsUserBook'], r['targetDb'], r['targetLineIndex'], r['targetLineIndexEnd'])}'
      ' ${r['connectionType']}$anchor$label';
}

void copyDir(Directory from, Directory to) {
  to.createSync(recursive: true);
  for (final e in from.listSync()) {
    if (e is File) e.copySync(p.join(to.path, p.basename(e.path)));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final skip = bundlePath == null || slicePath == null || attachedPath == null
      ? 'set OTZ_LINKER_BUNDLE, OTZ_LINKER_SLICE and OTZ_LINKER_ATTACHED'
      : null;

  setUpAll(() async {
    if (skip != null) return;
    temp = await Directory.systemTemp.createTemp('linker_live_');
    // the official library: a copy of the slice, opened by the app as seforim.db
    Directory(p.join(temp.path, 'library')).createSync(recursive: true);
    final officialPath = p.join(temp.path, 'library', 'seforim.db');
    File(slicePath!).copySync(officialPath);
    await Settings.init(cacheProvider: MemoryCacheProvider());
    await Settings.setValue(SettingsRepository.keyDbEffectivePath, officialPath);
    await Settings.setValue<String>(SettingsRepository.keyLibraryPath, p.join(temp.path, 'library'));
    await Settings.setValue<String>(SettingsRepository.keyLibraryFolderName, '');
    await UserBooksDatabaseHolder.instance.close();
    AppPaths.debugOverrideDataRootPath(p.join(temp.path, 'data'));
    userRepo = await UserBooksDatabaseHolder.instance.repository;
    officialDb = MyDatabase.withPath(officialPath, readOnly: true, official: true);
    folder = Directory(p.join(temp.path, 'books', booksDir));
    copyDir(Directory(p.join(bundlePath!, booksDir)), folder);
    // the providers Link.content reads the target text through (the preview and "open")
    await LibraryProviderManager.instance.initialize();
  });

  tearDownAll(() async {
    if (skip != null) return;
    final out = env['OTZ_LINKER_OUT'];
    if (out != null) {
      File(out).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(observed));
    }
    officialDb.close();
    await UserBooksDatabaseHolder.instance.close();
    LibraryProviderManager.instance.resetForTesting();
    FileSystemLibraryProvider.instance.resetForTesting();
    DatabaseLibraryProvider.instance.clearCache();
    try {
      await temp.delete(recursive: true);
    } catch (_) {}
  });

  group('the bundle through the app', skip: skip, () {
    test('folder scan: 5 books added, every links file applied, no error', () async {
      final result = await DatabaseLibraryProvider.instance.scanAndAddExternalBooksFromFolder(
        folder.path,
        booksDir,
        userRepo,
      );
      observed['scan'] = {
        'added': result.addedBooks,
        'failed': result.failedBooks,
        'failedDetails': [for (final (t, r) in result.failedDetails) '$t: $r'],
        'fatal': '${result.fatalError}',
      };
      expect(result.fatalError, isNull);
      expect(result.failedDetails, isEmpty);
      expect(result.addedBooks, 5);
      await registerBooks();
      // a personal book registered by the folder scan: how many lines it declares (the
      // out-of-range gate runs only when totalLines > 0, user_content_importer.dart:774-805)
      observed['personalTotalLines'] = {for (final t in [base, commentary, notes, citing, onGenesis]) t: (await userRepo.getAllBooksLean()).firstWhere((b) => b.title == t).totalLines};

      final repo = UserContentRepository(userRepo.database);
      final files = (await userRepo.database.database).select('SELECT path FROM user_sidecar_file').map((r) => p.basename(r['path'] as String)).toList()..sort();
      observed['sidecarFiles'] = files;
      expect(files, [
        '$base' '_links.json',
        '$citing' '_links.json',
        '$onGenesis' '_links.json',
        '$genesis' '_links.json',
      ]..sort());
      expect(repo, isNotNull);

      final rows = await userLinkRows();
      observed['user_link'] = rows.map(rowKey).toList();
      expect(rows.every((r) => r['source'] != null), isTrue);
      expect(rows.map(rowKey).toList()..sort(), [
        // L1–L5 and L9 (written at its base as commentary): base file, as written
        '$base:3 → $commentary:3 COMMENTARY',
        '$base:4 → $commentary:4 COMMENTARY @47-51',
        '$base:5 → $commentary:5 COMMENTARY @54 "א"',
        '$base:6 → $notes:2 FOOTNOTES',
        '$base:7 → $citing:3-5 REFERENCE',
        '$base:8 → $commentary:6 COMMENTARY',
        // L6–L8
        '$citing:7-8 → $base:9 REFERENCE',
        '$citing:9 → $base:11 REFERENCE',
        '$citing:10 → $genesis (רשמי):3 REFERENCE',
        // L10: personal commentary → official base, reversed by the app (no anchor, no heRef)
        '$genesis (רשמי):4 → $onGenesis:2 COMMENTARY',
        // L11 (written at בראשית as commentary) and L12: from the official book's file
        '$genesis (רשמי):5 → $onGenesis:3 COMMENTARY',
        '$genesis (רשמי):6 → $onGenesis:4 COMMENTARY',
      ]..sort());
    });

    test('L1–L3, L9: the commentary shows in the base\'s commentary panel; the base is "מקור" in the commentary', () async {
      expect(await commentatorsOf(base), unorderedEquals([commentary, notes]));
      final seen = <String, Object?>{};
      for (final (id, line, target) in [('L1', 3, 3), ('L2', 4, 4), ('L3', 5, 5), ('L9', 8, 6)]) {
        final at = await panelsAt(base, line);
        seen[id] = {'base': {'commentaryPanel': at.commentaries, 'linksPanel': at.linksPanel}};
        expect(at.commentaries, ['$commentary:$target COMMENTARY'], reason: id);
        expect(at.linksPanel, isEmpty, reason: id);
        final back = await panelsAt(commentary, target);
        (seen[id] as Map)['commentary'] = {'commentaryPanel': back.commentaries, 'linksPanel': back.linksPanel};
        expect(back.linksPanel, ['$base:$line SOURCE'], reason: id);
        expect(back.commentaries, isEmpty, reason: id);
        expect(LinkTypes.hebrewLabels[LinkTypes.source], 'מקור');
        expect(await commentatorsOf(commentary), isEmpty);
      }
      // the text the panel shows (and opens): the commentary's line
      final l9 = (await panelsAt(base, 8)).all.single;
      final text = await l9.content;
      seen['L9 content'] = text;
      expect(text, startsWith('[פ-6]'));
      observed['commentary'] = seen;
    });

    test('L2, L3: the anchors land on the words (raw offsets → visible, link_anchor_markers.dart)', () async {
      final lines = await linesOf(base);
      final results = <String, String>{};
      for (final (id, line) in [('L2', 4), ('L3', 5)]) {
        final links = await linksOf(base);
        final byLine = buildLinksByLineMap(links);
        final anchorLinks = (byLine[line] ?? const <Link>[]).where((l) => l.anchorStart != null).toList();
        expect(anchorLinks, hasLength(1), reason: id);
        expect(anchorLinks.single.anchorOffsetsAreRaw, isTrue);
        results[id] = injectLinkAnchorMarkers(
          rawLine: lines[line - 1],
          anchorLinks: anchorLinks,
          styleIndexByCommentator: anchorStyleIndexByCommentator(links),
          lineIndex: line - 1,
        );
      }
      observed['anchors'] = results;
      expect(results['L2'], contains('<a class="link-anchor-range" href="otzaria://anchor?ref=3_0&range=1">יעקב</a>'));
      expect(RegExp(r'<a class="link-anchor[^"]*" href="otzaria://anchor\?ref=4_0">[^<]*א[^<]*</a>רחל').hasMatch(results['L3']!), isTrue,
          reason: results['L3']);
      expect(anchorMarkerLetter((await panelsAt(base, 5)).all.single), 'א');
      // the target side carries no anchor (user_links_loader.dart:91-112)
      expect((await linksOf(commentary)).where((l) => l.anchorStart != null), isEmpty);
    });

    test('L4: footnotes — the (1) marker gets a hover note, and the note opens with (1)', () async {
      final lines = await linesOf(base);
      final at = await panelsAt(base, 6);
      final noteLinks = numberedNoteLinks(at.all);
      expect(noteLinks.map(show), ['$notes:2 FOOTNOTES']);
      final html = addNumberedNoteMarkerLinks(lines[5], lineIndex: 5);
      expect(html, contains('href="otzaria://note-marker?line=5&num=1">(1)</a>'));
      final hover = await numberedNoteLinkFromUrl('otzaria://note-marker?line=5&num=1', at.all);
      observed['L4'] = {'commentaryPanel': at.commentaries, 'linksPanel': at.linksPanel, 'marker': html, 'hover': hover == null ? null : await hover.content};
      expect(hover, isNotNull);
      expect(await hover!.content, startsWith('(1) זו ההערה'));
      expect(at.commentaries, ['$notes:2 FOOTNOTES']); // FOOTNOTES is a dependent type: commentary panel
      expect(LinkTypes.hebrewLabels[LinkTypes.footnotes], 'הערות שוליים');
    });

    test('L5–L7: links panel, ranges on both sides, the exact line after a heading', () async {
      final seen = <String, Object?>{};
      // L5: base:7 → citing:3-5
      final l5 = await panelsAt(base, 7);
      seen['L5 base:7'] = l5.linksPanel;
      expect(l5.linksPanel, ['$citing:3-5 REFERENCE']);
      expect(await l5.all.single.content, allOf(contains('[מ-3]'), contains('[מ-4]'), contains('[מ-5]')));
      for (final line in [3, 4, 5, 6]) {
        final c = await panelsAt(citing, line);
        seen['L5 citing:$line'] = c.linksPanel;
        expect(c.linksPanel, line == 6 ? isEmpty : ['$base:7 REFERENCE'], reason: 'citing:$line');
      }
      // L6: citing:7-8 → base:9
      for (final line in [7, 8]) {
        final c = await panelsAt(citing, line);
        seen['L6 citing:$line'] = c.linksPanel;
        expect(c.linksPanel, ['$base:9 REFERENCE'], reason: 'citing:$line');
      }
      expect(await (await panelsAt(citing, 7)).all.single.content, startsWith('[ב-9]'));
      expect((await panelsAt(base, 9)).linksPanel, ['$citing:7 REFERENCE']);
      final back = (await panelsAt(base, 9)).all.single;
      seen['L6 base:9 back'] = '${back.index2}-${back.index2End}';
      // L7: citing:9 → base:11 (the line AFTER "פרק ב")
      final l7 = (await panelsAt(citing, 9)).all.single;
      seen['L7'] = {'index2': l7.index2, 'content': await l7.content};
      expect(l7.index2, 11);
      expect(await l7.content, startsWith('[ב-11]'));
      observed['references'] = seen;
    });

    test('L8, L10–L12: the official Sefaria book (בראשית) — panels both ways, the verse each opens', () async {
      final seen = <String, Object?>{};
      // L8: citing:10 → בראשית line 3 = 1:1
      final l8 = (await panelsAt(citing, 10));
      seen['L8 citing:10'] = l8.linksPanel;
      expect(l8.linksPanel, ['$genesis:3 REFERENCE [o]']);
      final l8Text = await l8.all.single.content;
      seen['L8 content'] = l8Text;
      // the official line 3 (0-based 2) is the verse 1:1
      final heRef = (await officialDb.database).select('SELECT heRef FROM line WHERE bookId = 1 AND lineIndex = 2').single['heRef'];
      expect(heRef, 'בראשית, א, א');
      expect(l8Text.replaceAll(RegExp('<[^>]*>'), '').replaceAll(RegExp('[֑-ׇ]'), ''), contains('בראשית ברא אלהים את השמים')); // without the vowel and cantillation marks
      final g3 = await panelsAt(genesis, 3);
      seen['L8 genesis:3'] = g3.linksPanel;
      expect(g3.linksPanel, ['$citing:10 REFERENCE']);

      expect(await commentatorsOf(genesis), [onGenesis]);
      for (final (id, verseLine, target) in [('L10', 4, 2), ('L11', 5, 3), ('L12', 6, 4)]) {
        final g = await panelsAt(genesis, verseLine);
        seen['$id genesis:$verseLine'] = {'commentaryPanel': g.commentaries, 'linksPanel': g.linksPanel};
        expect(g.commentaries, ['$onGenesis:$target COMMENTARY'], reason: id);
        expect(g.linksPanel, isEmpty, reason: id);
        expect(await (await linksOf(genesis)).firstWhere((l) => l.index1 == verseLine).content, startsWith('[ס-$target]'), reason: id);
        final c = await panelsAt(onGenesis, target);
        seen['$id onGenesis:$target'] = {'commentaryPanel': c.commentaries, 'linksPanel': c.linksPanel};
        expect(c.linksPanel, ['$genesis:$verseLine SOURCE [o]'], reason: id);
        expect(c.commentaries, isEmpty, reason: id);
      }
      observed['genesis'] = seen;
    });

    test('Settings import ("ייבוא נתונים"): the citing file again — 3 links, each shown once', () async {
      final path = p.join(bundlePath!, booksDir, '$citing' '_links.json');
      final library = UserImportLibrary(userRepo.database);
      final outcome = await library.addFiles([path]);
      observed['settingsImport'] = {'links': outcome.added.linksApplied, 'errors': outcome.allErrors};
      expect(outcome.allErrors, isEmpty);
      expect(outcome.added.linksApplied, 3);
      final rows = await userLinkRows();
      expect(rows.where((r) => r['source'] == null), hasLength(3));
      expect((await panelsAt(citing, 9)).linksPanel, ['$base:11 REFERENCE']);
      expect((await panelsAt(citing, 7)).linksPanel, ['$base:9 REFERENCE']);
      // "delete file": the folder's links stay
      final file = (await library.list()).single;
      await library.remove(file.id);
      expect((await userLinkRows()).where((r) => r['source'] == null), isEmpty);
      expect((await panelsAt(citing, 9)).linksPanel, ['$base:11 REFERENCE']);
    });

    test('N1: an unknown type rejects the whole file, with the message', () async {
      final path = p.join(bundlePath!, 'negative', '$notes' '_links.json');
      final before = (await userLinkRows()).length;
      final library = UserImportLibrary(userRepo.database);
      final outcome = await library.addFiles([path]);
      observed['N1'] = {'links': outcome.added.linksApplied, 'errors': outcome.allErrors};
      expect(outcome.allErrors.join('\n'), contains('סוג קישור לא מוכר: "commentry"'));
      expect((await userLinkRows()).length, before);
      // N1a (the valid record of the rejected file) is not there: only L4's inverse
      expect((await panelsAt(notes, 2)).linksPanel, ['$base:6 SOURCE']);
      for (final f in await library.list()) {
        await library.remove(f.id);
      }
    });

    test('check 15: new content keeps the line numbers; the moved files move them', () async {
      final seen = <String, Object?>{};
      File(p.join(bundlePath!, 'update', '$base.txt')).copySync(p.join(folder.path, '$base.txt'));
      File(p.join(folder.path, '$base.txt')).setLastModifiedSync(DateTime.now().add(const Duration(minutes: 5)));
      var result = await DatabaseLibraryProvider.instance.scanAndAddExternalBooksFromFolder(folder.path, booksDir, userRepo);
      expect(result.failedDetails, isEmpty);
      expect(result.updatedBooks, 1);
      final lines = await linesOf(base);
      expect(lines, hasLength(13));
      // 15a: the stored numbers stay; L1 now sits on the heading "פרק א", L7 opens "פרק ב"
      seen['15a base:3'] = (await panelsAt(base, 3)).commentaries;
      expect((await panelsAt(base, 3)).commentaries, ['$commentary:3 COMMENTARY']);
      expect(lines[2], '<h2>פרק א</h2>');
      final l7 = (await panelsAt(citing, 9)).all.single;
      seen['15a L7'] = await l7.content;
      expect(l7.index2, 11);

      for (final name in ['$base' '_links.json', '$citing' '_links.json']) {
        final f = File(p.join(folder.path, name));
        File(p.join(bundlePath!, 'update', name)).copySync(f.path);
        f.setLastModifiedSync(DateTime.now().add(const Duration(minutes: 10)));
      }
      result = await DatabaseLibraryProvider.instance.scanAndAddExternalBooksFromFolder(folder.path, booksDir, userRepo);
      expect(result.failedDetails, isEmpty);
      // 15b: L1 on line 4 ([ב-3]), the L2 anchor on יעקב in line 5, L7 opens line 12 ([ב-11])
      expect((await panelsAt(base, 4)).commentaries, ['$commentary:3 COMMENTARY']);
      expect((await panelsAt(base, 3)).commentaries, isEmpty);
      final links = await linksOf(base);
      final anchored = (buildLinksByLineMap(links)[5] ?? const <Link>[]).where((l) => l.anchorStart != null).toList();
      final html = injectLinkAnchorMarkers(
        rawLine: lines[4],
        anchorLinks: anchored,
        styleIndexByCommentator: anchorStyleIndexByCommentator(links),
        lineIndex: 4,
      );
      seen['15b L2'] = html;
      expect(html, contains('>יעקב</a>'));
      final moved = (await panelsAt(citing, 9)).all.single;
      seen['15b L7'] = await moved.content;
      expect(moved.index2, 12);
      expect(await moved.content, startsWith('[ב-11]'));
      expect((await panelsAt(base, 8)).linksPanel, ['$citing:3-5 REFERENCE']);
      expect((await panelsAt(citing, 7)).linksPanel, ['$base:10 REFERENCE']);
      observed['update'] = seen;
    });

    test('several databases (dbs/): a personal database attached as a library', () async {
      final seen = <String, Object?>{};
      final attached = File(attachedPath!).copySync(p.join(temp.path, 'attached.db'));
      final dbs = Directory(p.join(temp.path, 'books', 'dbs'));
      copyDir(Directory(p.join(bundlePath!, 'dbs')), dbs);
      final libraries = [(slug: slug, path: attached.path, immutable: true, visible: true)];
      final errors = await UserSidecarSync.applyForFolder(
        userDb: userRepo.database,
        folderPath: dbs.path,
        officialRepository: SeforimRepository(officialDb),
        attachedLibraries: libraries,
      );
      seen['errors'] = errors;
      expect(errors, isEmpty);
      final rows = (await userLinkRows()).where((r) => (r['source'] as String?)?.contains('${p.separator}dbs${p.separator}') ?? false).map(rowKey).toList();
      seen['user_link'] = rows;
      expect(rows..sort(), [
        '$genesis (רשמי):8 → $personalDb ($slug):7 REFERENCE',
        '$personalDb ($slug):5 → $citing:2 REFERENCE',
        '$personalDb ($slug):6 → $citing:6 COMMENTARY',
      ]..sort());

      final attachedDb = MyDatabase.untrusted(attached.path, immutable: true);
      final cat = (await attachedDb.database).select('SELECT categoryId FROM book WHERE title = ?', [personalDb]).single['categoryId'] as int;
      attachedDb.close();
      books[personalDb] = (source: BookSource.attached(slug), categoryId: cat, filePath: null, fileType: null);
      // D1: reading the personal database's book
      final d1 = await panelsAt(personalDb, 5);
      seen['D1 personalDb:5'] = d1.linksPanel;
      expect(d1.linksPanel, ['$citing:2 REFERENCE']);
      expect(await d1.all.single.content, startsWith('[מ-2]'));
      expect((await panelsAt(citing, 2)).linksPanel, ['$personalDb:5 REFERENCE [d:$slug]']);
      // D2: source → written as commentary at the personal database's book
      expect(await commentatorsOf(personalDb), [citing]);
      final d2 = await panelsAt(personalDb, 6);
      seen['D2 personalDb:6'] = {'commentaryPanel': d2.commentaries, 'linksPanel': d2.linksPanel};
      expect(d2.commentaries, ['$citing:6 COMMENTARY']);
      final d2back = await panelsAt(citing, 6);
      seen['D2 citing:6'] = d2back.linksPanel;
      expect(d2back.linksPanel, ['$personalDb:6 SOURCE [d:$slug]']);
      // D3: official → personal database
      final d3 = await panelsAt(genesis, 8);
      seen['D3 genesis:8'] = d3.linksPanel;
      expect(d3.linksPanel, ['$personalDb:7 REFERENCE [d:$slug]']);
      final d3back = await panelsAt(personalDb, 7);
      seen['D3 personalDb:7'] = d3back.linksPanel;
      expect(d3back.linksPanel, ['$genesis:8 REFERENCE [o]']);
      observed['dbs'] = seen;
    });

    test('R1: a personal base with an OFFICIAL commentary (commentary) — stored reversed', () async {
      final dir = Directory(p.join(temp.path, 'books', 'reversed'));
      copyDir(Directory(p.join(bundlePath!, 'reversed')), dir);
      final errors = await UserSidecarSync.applyForFolder(
        userDb: userRepo.database,
        folderPath: dir.path,
        officialRepository: SeforimRepository(officialDb),
        attachedLibraries: const [],
      );
      expect(errors, isEmpty);
      final rows = (await userLinkRows()).where((r) => (r['source'] as String?)?.contains('${p.separator}reversed${p.separator}') ?? false).map(rowKey).toList();
      final rashiCat = (await officialDb.database).select('SELECT categoryId FROM book WHERE title = ?', [rashi]).single['categoryId'] as int;
      books[rashi] = (source: BookSource.official, categoryId: rashiCat, filePath: null, fileType: null);
      final b = await panelsAt(base, 12);
      final r = await panelsAt(rashi, 5);
      observed['R1'] = {
        'user_link': rows,
        'base:12': {'commentaryPanel': b.commentaries, 'linksPanel': b.linksPanel},
        'base commentators': await commentatorsOf(base),
        'rashi:5': {'commentaryPanel': r.commentaries, 'linksPanel': r.linksPanel},
        'rashi commentators': await commentatorsOf(rashi),
      };
      // what the app does: the official commentary becomes the BASE of the personal book
      expect(rows, ['$rashi (רשמי):5 → $base:12 COMMENTARY']);
      expect(await commentatorsOf(base), isNot(contains(rashi)));
      expect(b.linksPanel, contains('$rashi:5 SOURCE [o]')); // (L7 lands on line 12 too, after check 15)
      expect(await commentatorsOf(rashi), [base]);
      expect(r.commentaries, ['$base:12 COMMENTARY']);
    });

    test('title clashes: a personal-database book named like an official book binds to the OFFICIAL one', () async {
      // the attached slice also holds a בראשית; a file made for IT lands on the official בראשית
      final dir = Directory(p.join(temp.path, 'books', 'clash'))..createSync(recursive: true);
      File(p.join(dir.path, '$genesis' '_links.json')).writeAsStringSync(
        '[{"line_index_1": 9, "heRef_2": "x", "path_2": "$citing.txt", "line_index_2": 2, "Conection Type": "reference"}]',
      );
      final errors = await UserSidecarSync.applyForFolder(
        userDb: userRepo.database,
        folderPath: dir.path,
        officialRepository: SeforimRepository(officialDb),
        attachedLibraries: [(slug: slug, path: p.join(temp.path, 'attached.db'), immutable: true, visible: true)],
      );
      final rows = (await userLinkRows()).where((r) => (r['source'] as String?)?.contains('${p.separator}clash${p.separator}') ?? false).map(rowKey).toList();
      observed['clash attached'] = {'errors': errors, 'rows': rows};
      expect(errors, isEmpty);
      expect(rows, ['$genesis (רשמי):9 → $citing:2 REFERENCE']);
    });

    test('title clashes: a personal TEXT book named like an official book rejects the whole file', () async {
      final dir = Directory(p.join(temp.path, 'books', 'clash-txt'))..createSync(recursive: true);
      File(p.join(dir.path, '$genesis.txt')).writeAsStringSync('<h1>$genesis</h1>\nשורה');
      File(p.join(dir.path, '$genesis' '_links.json')).writeAsStringSync(
        '[{"line_index_1": 2, "heRef_2": "x", "path_2": "$citing.txt", "line_index_2": 2, "Conection Type": "reference"}]',
      );
      File(p.join(dir.path, 'other_links.json')).writeAsStringSync('[]');
      final result = await DatabaseLibraryProvider.instance.scanAndAddExternalBooksFromFolder(dir.path, 'clash-txt', userRepo);
      final details = [for (final (t, r) in result.failedDetails) '$t: $r'];
      observed['clash txt'] = {'added': result.addedBooks, 'failedBooks': result.failedBooks, 'failedDetails': details};
      expect(result.addedBooks, 1);
      expect(details.join('\n'), contains('קיים גם בספרייה האישית וגם ברשמית'));
      // the scan reports it only through failedDetails; failedBooks stays 0 (custom_folders_bloc.dart
      // shows the error only when failedBooks > 0)
      expect(result.failedBooks, 0);
    });

    test('out of range: a personal book from the folder scan — is the line count checked?', () async {
      final dir = Directory(p.join(temp.path, 'books', 'range'))..createSync(recursive: true);
      File(p.join(dir.path, 'בדיקת טווח.txt')).writeAsStringSync('<h1>בדיקת טווח</h1>\nשורה');
      File(p.join(dir.path, 'בדיקת טווח_links.json')).writeAsStringSync(
        '[{"line_index_1": 40, "heRef_2": "x", "path_2": "$citing.txt", "line_index_2": 2, "Conection Type": "reference"}]',
      );
      final result = await DatabaseLibraryProvider.instance.scanAndAddExternalBooksFromFolder(dir.path, 'range', userRepo);
      final details = [for (final (t, r) in result.failedDetails) '$t: $r'];
      final total = (await userRepo.getAllBooksLean()).firstWhere((b) => b.title == 'בדיקת טווח').totalLines;
      final rows = (await userLinkRows()).where((r) => r['sourceTitle'] == 'בדיקת טווח').map(rowKey).toList();
      observed['out of range'] = {'totalLines': total, 'failedDetails': details, 'rows': rows};
      // recorded, not asserted either way: the tool never writes such a line (it checks the count itself)
    });
  });
}
