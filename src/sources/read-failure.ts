/** The browser refused to read a file's bytes (Chrome: NotReadableError; Firefox: NotFoundError; a policy: SecurityError). */
export const isReadFailure = (err: unknown): boolean => ["NotReadableError", "NotFoundError", "SecurityError"].includes((err as { name?: string })?.name ?? "");

/**
 * Version 3's message for a file that cannot be read (F-012), with the two causes users meet: Otzaria holds the
 * database open, or the file is in the cloud only (OneDrive/Drive "files on demand") and not on the computer. And the
 * cause V7 met: the file changed or was deleted after it was chosen.
 */
export function unreadableReason(err: unknown, path?: string): string {
  if (!isReadFailure(err)) return `לא הצלחתי לקרוא את ${path ? `הקובץ "${path}"` : "הקובץ"} (${err instanceof Error ? err.message : String(err)}).`;
  return `הדפדפן לא הצליח לקרוא את ${path ? `הקובץ "${path}"` : "הקובץ"}. ייתכן שאוצריא פתוחה ונועלת אותו, שהקובץ שמור בענן (OneDrive או Google Drive) ולא הורד למחשב, או שהוא השתנה או נמחק אחרי שנבחר. סגרו את אוצריא, ודאו שהקובץ נמצא במחשב, ובחרו אותו שוב.`;
}
