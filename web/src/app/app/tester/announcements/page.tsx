import { redirect } from 'next/navigation'

/**
 * Kept only to catch old links.
 *
 * The flat announcements feed is gone: a build-scoped announcement is read at
 * Project → Build → Announcements, where it has the context that makes it
 * mean something, and a platform-wide one is broadcast and appears in the
 * Communications inbox. Neither belongs in a global list of its own.
 *
 * A redirect rather than a deletion because this path was in the sidebar for
 * the life of the portal, so it is in browser histories and bookmarks. A 404
 * would be a worse answer than the inbox that now holds what this page used
 * to show.
 */
export default function TesterAnnouncementsPage() {
  redirect('/app/tester/communication')
}
