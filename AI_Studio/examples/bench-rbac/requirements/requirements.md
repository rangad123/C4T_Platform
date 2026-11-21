# BenchNotes requirements

This document describes how BenchNotes is intended to behave. It is the product owner's statement of the expected behaviour, written
for the people who build and test the application: where the application behaves differently, the application is wrong, not this
document. Each requirement is one numbered line; the numbers are stable.

## 1. Roles

- 1.1 BenchNotes is a notes application for a team: people keep private notes and share them with colleagues by email.
- 1.2 Everyone with an account has one role: user, manager or admin.
- 1.3 A user keeps their own notes and reads the notes shared with them.
- 1.4 A manager can do everything a user can and can also read every note.
- 1.5 An admin can do everything a manager can and can also see everyone with an account and change their roles.
- 1.6 A person's role is shown on their Account page.

## 2. Visitors, accounts and signing in

- 2.1 A visitor (not signed in) can open the welcome page, the sign-in page and the create-account page; any other page takes them to the sign-in page and, after signing in, back to the page they asked for.
- 2.2 A signed-in person who opens the welcome page is taken to their notes.
- 2.3 The main navigation shows Notes, New note, Account and Sign out to signed-in people, People to admins, and Sign in and Create account to visitors.
- 2.4 Anyone can create an account with a name, an email address and a password.
- 2.5 The name is required; an empty name is refused with "Enter your name."
- 2.6 The email address must be a valid email address; anything else is refused with "Enter a valid email address."
- 2.7 A password needs at least 8 characters; a shorter one is refused with a message that states the minimum (API: 400).
- 2.8 An email address can belong to one account only; registering again with it is refused (API: 409).
- 2.9 Every new account is a user.
- 2.10 A new account is signed in straight away and lands on the notes list.
- 2.11 A person signs in with their email address and password; a wrong combination is refused with "Email or password is wrong." (API: 401).
- 2.12 Signing out ends the session: from then on that session gives no access at all, and the person is a visitor again.
- 2.13 The Account page shows the person's name, email address and role.
- 2.14 After 5 failed sign-ins for the same email address within one minute, every sign-in for that email address is refused for one minute with "Too many failed sign-ins. Try again in a minute." (API: 429), even with the right password.

## 3. Notes

- 3.1 The Notes page lists every note the person may read, each with its title and its owner's name.
- 3.2 A person with no note they may read sees "No notes yet."
- 3.3 Anyone signed in can create a note with a title and an optional text; the person who creates a note is its owner.
- 3.4 Every note has a title: creating a note without one is refused with "Give the note a title." (API: 400), and no note is created.
- 3.5 A title has at most 120 characters; a longer one is refused with a message (API: 400).
- 3.6 After creating a note the person sees the new note's page.
- 3.7 A note can be read by its owner, by the people it is shared with, by managers and by admins.
- 3.8 For anyone else a note does not exist: it shows "Note not found" (page and API: 404), the same as a note that was never created.
- 3.9 A note page shows the title, the owner's name, the text and who the note is shared with ("Nobody." when it is shared with no one).
- 3.10 Only the owner can change a note's title or text; anyone else who may read it is refused with "Only the owner can change this note." (API: 403).
- 3.11 A changed note still needs a title (API: 400).
- 3.12 Saving changes to a note shows "Saved." and leaves its sharing as it was.
- 3.13 Only the owner can delete a note; anyone else who may read it is refused (API: 403). After deleting it, the owner is back on the notes list.
- 3.14 The edit, share and delete controls appear on a note's page for its owner only.
- 3.15 A note's title and text are always shown as plain text, exactly as typed: characters such as < and > never become part of the page's markup.
- 3.16 Deleting a note also deletes its sharing: no stored share is ever left for a note that no longer exists.

## 4. Sharing

- 4.1 Only the owner can share a note or stop sharing it; anyone else who may read it is refused (API: 403).
- 4.2 The owner shares a note by entering a colleague's email address; the colleague can then read the note.
- 4.3 Sharing with an email address that has no account is refused with "No one with that email." (API: 404).
- 4.4 The owner cannot share a note with themselves (API: 400).
- 4.5 Sharing a note again with someone who already has it changes nothing.
- 4.6 The owner can stop sharing the note with anyone on its list; that person can then no longer read the note.
- 4.7 Stopping sharing with someone the note is not shared with is refused (API: 404).

## 5. People and roles

- 5.1 The People page lists everyone with an account, with their name, email address and role, and lets an admin change each role.
- 5.2 Only admins can open the People page; anyone else sees "Not allowed" (403).
- 5.3 Only admins can get the list of people through the API; anyone else is refused with "Only admins can see people." (403).
- 5.4 Only admins can change a person's role; anyone else is refused with "Only admins can change roles." (403).
- 5.5 A role is user, manager or admin; any other value is refused with "Choose user, manager or admin." (API: 400).
- 5.6 Changing the role of a person who does not exist is refused with "Person not found." (API: 404).
- 5.7 A changed role applies from the person's next request.

## 6. API

- 6.1 The JSON API is described at /openapi.json, and every operation answers with the status codes described there.
- 6.2 API operations other than registering, signing in and signing out answer 401 with "Sign in first." to a visitor.
- 6.3 API errors are JSON objects with an error message that can be shown to the person.
- 6.4 Request bodies larger than 64 KB are ignored.
