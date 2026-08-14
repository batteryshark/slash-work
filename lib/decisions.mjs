// One definition of "this decision still wants a human", imported by the
// server and the web client, and ported to Swift with a test pinning it.
// It lived in three places and disagreed in one: an expired deferral counted
// as active in both clients and not in /api/needs-you, so the queue the
// sweeper reads quietly disagreed with the queue the human sees.

/** A decision is active while it is open, or once a deferral's date has passed.
 *  Deliberately single-argument: both call sites pass this straight to
 *  Array.filter, which supplies the index as a second argument — a `now`
 *  parameter here would silently become 0 and report everything inactive. */
export function decisionIsActive(decision) {
  if (!decision) return false;
  if (decision.status === "open") return true;
  if (decision.status !== "deferred") return false;
  const until = decision.resolution?.choice?.until;
  return typeof until === "string" && new Date(until).getTime() <= Date.now();
}
