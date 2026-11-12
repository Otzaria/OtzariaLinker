import { htmlToPlainText } from "../../core/text/html";

/**
 * A book line as plain text for snippets: tags removed AND entities decoded (stripTags leaves
 * "&thinsp;" as is — UX review #10). The pure version lives in core, so the worker's search
 * snippets and the UI's snippets are the same text.
 */
export const plainText = (html: string): string => htmlToPlainText(html);
