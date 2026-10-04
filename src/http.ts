// #1675: a fetch response whose body is never read keeps undici's socket checked out, and so keeps the
// process alive, until the Response is garbage-collected. Every early return on a response we won't read
// must discard its body.
export function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => {});
}
