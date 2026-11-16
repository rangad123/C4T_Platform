# BenchNotes: product requirements

Scope: BenchNotes is a small notes application for a team. People keep private notes, share them with colleagues by email, and stop
sharing again. Managers can read every note; admins also see everyone with an account and change roles. This document states the
intended behaviour of the web pages and of the JSON API described at `/openapi.json`. Each requirement is one numbered line; the numbers
are stable and other documents refer to them.

## 1. Roles and access

- 1.1 There are four kinds of people: visitors (not signed in), users, managers and admins.
- 1.2 Users keep their own notes and read notes shared with them.
- 1.3 Managers can do everything a user can and can also read every note.
- 1.4 Admins can do everything a manager can and can also see everyone with an account and change roles.
- 1.5 Visitors see the welcome page, the sign-in page and the create-account page; any other page sends them to sign in and back to that page afterwards.
- 1.6 Every API operation other than registration, sign-in and sign-out answers 401 to a visitor with "Sign in first."
- 1.7 The main navigation shows Notes, New note, Account and Sign out to signed-in people, and People to admins only.
- 1.8 A signed-in person who opens the welcome page goes to their notes.

## 2. Accounts and sessions

- 2.1 Anyone can create an account with a name, an email address and a password.
- 2.2 The name is required; an empty name is refused with "Enter your name."
- 2.3 The email address must be a valid email address; anything else is refused with "Enter a valid email address."
- 2.4 Passwords need at least 8 characters; a shorter password is refused with a message stating the minimum (API: 400).
- 2.5 An email address can belong to one account only; a second registration with it is refused (API: 409).
- 2.6 Every new account is a user; nobody can choose their own role when registering.
- 2.7 A new account is signed in straight away and lands on the notes list.
- 2.8 Signing in needs the account's email address and password; a wrong combination shows "Email or password is wrong." (API: 401).
- 2.9 Signing out ends the session on the server: the session can no longer be used for any page or API request, even if its cookie value is sent again.
- 2.10 The Account page shows the person's name, email address and role.

## 3. Notes list and creation

- 3.1 The Notes page lists every note the person may read, each with its title and its owner's name.
- 3.2 A person with no readable notes sees "No notes yet."
- 3.3 Anyone signed in can create a note with a title and an optional text; the creator is its owner.
- 3.4 Every note needs a title; creating a note without one is refused with "Give the note a title." (API: 400) and no note is created.
- 3.5 A title has at most 120 characters; a longer one is refused with a message (API: 400).
- 3.6 After creating a note the person sees the new note's page.

## 4. Reading notes

- 4.1 A note can be read by its owner, by people it is shared with, by managers and by admins.
- 4.2 Anyone else who opens a note sees "Note not found" (page and API: 404), exactly as for a note that does not exist.
- 4.3 A note page shows the title, the owner's name, the text and the list of people it is shared with ("Nobody." when none).

## 5. Changing and deleting notes

- 5.1 Only the owner can change a note's title or text; anyone else who can read the note, including people it is shared with, managers and admins, is refused with "Only the owner can change this note." (API: 403).
- 5.2 A changed note still needs a title; an empty title is refused (API: 400).
- 5.3 Saving changes shows "Saved." and keeps the note's sharing as it was.
- 5.4 Only the owner can delete a note; anyone else who can read it is refused (API: 403). After deleting, the owner returns to the notes list.
- 5.5 The edit, share and delete controls appear on a note page for its owner only.

## 6. Sharing

- 6.1 Only the owner can share a note or stop sharing it; anyone else who can read it is refused (API: 403).
- 6.2 The owner shares a note by entering a colleague's email address; the colleague can then read it.
- 6.3 Sharing with an email address that has no account is refused with "No one with that email." (API: 404).
- 6.4 The owner cannot share a note with themselves (API: 400).
- 6.5 Sharing with someone who already has the note changes nothing.
- 6.6 The owner can stop sharing with any person on the list; from then on that person can no longer read the note.
- 6.7 Stopping sharing with someone the note is not shared with is refused (API: 404).

## 7. People and roles (admins)

- 7.1 The People page lists everyone with an account with name, email address and role, and lets the admin change each role.
- 7.2 Only admins can open the People page; anyone else sees "Not allowed" (403).
- 7.3 Only admins can get the list of people through the API; anyone else is refused with "Only admins can see people." (403).
- 7.4 Only admins can change a person's role; anyone else, managers included, is refused with "Only admins can change roles." (403).
- 7.5 A role is one of user, manager or admin; any other value is refused with "Choose user, manager or admin." (API: 400).
- 7.6 Changing the role of a person who does not exist is refused with "Person not found." (API: 404).
- 7.7 A role change takes effect on the person's next request.

## 8. API

- 8.1 The JSON API is described at `/openapi.json`; every operation behaves as described there, including the status codes listed.
- 8.2 Errors are JSON objects with an `error` message suitable to show to the person.
- 8.3 Request bodies over 64 KB are ignored.
- 8.4 A person who may not read a note gets 404 for every operation on it, never 403, so its existence is not revealed.
