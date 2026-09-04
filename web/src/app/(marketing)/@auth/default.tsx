/**
 * Nothing, which is the point.
 *
 * A parallel slot that cannot match the current URL renders this. Without it
 * Next answers 404 for every marketing route that is not `/login` or
 * `/register` — see "Unmatched routes" in the parallel-routes docs.
 *
 * It is also what makes the fallback work: on a hard load of `/login` there is
 * no page underneath to put a dialog over, so this slot renders nothing and
 * the standalone page handles it.
 */
export default function AuthSlotDefault() {
  return null
}
