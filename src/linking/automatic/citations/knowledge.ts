import chapterNames from "./knowledge/chapter-names.json";
import rambamTopics from "./knowledge/rambam-topics.json";

/*
 * The names books write, as data apart from the algorithm (made by scripts/citations/knowledge.py from the real
 * seforim.db and checked against it by tests/validation/citations-knowledge.test.ts).
 */

/**
 * How books write a topic of the Mishneh Torah where the library's title does not say it: "מעשר" (מעשרות — books
 * mean it, though it opens מעשר שני too), "שביעית" (שמיטה ויובל), "איסורי מזבח" (איסורי המזבח), "פסוהמ"ק". Mined
 * from the LINKER citations into each topic, kept when the engine did not read them so and the letters fit.
 * `linker`: how many of the mined citations wrote it so.
 */
export const RAMBAM_TOPIC_NAMES: readonly { readonly written: string; readonly topic: string; readonly linker: number }[] = rambamTopics.names;

/**
 * The chapters of the Mishnah and the Yerushalmi, each by its opening words ("מאימתי קורין את שמע") — how chapters are
 * named. The database has chapter names (alt_toc) for the Bavli only; these are read from each book's own text.
 * By the book's title, in order (chapter 1 first).
 */
export const CHAPTER_OPENINGS: Readonly<Record<string, readonly string[]>> = chapterNames.books;
