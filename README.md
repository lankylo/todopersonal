# Our List

A small shared household to-do web app built with plain HTML, CSS, JavaScript
and Supabase.

## What version one does

- Email sign-in
- Create one household
- Join it with a private invite code
- Add tasks
- Edit title and notes
- Assign a task to either person or leave it as "Either of us"
- Move tasks through Inbox, Next, Waiting and Done
- Reopen and delete tasks
- Live updates on both phones
- Install from the browser as a home-screen web app

The daily interface does not show due dates, recurring rules, priorities,
categories or timestamps.

## 1. Create the Supabase project

1. Create a project at Supabase.
2. Open **SQL Editor**.
3. Paste the full contents of `supabase-schema.sql`.
4. Run it once.

## 2. Add the browser connection values

Open the Supabase project's **Connect** dialog or API settings and copy:

- Project URL
- Publishable key (older projects may call this the anon key)

Paste them into `config.js`:

```js
window.APP_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabasePublishableKey: "YOUR_PUBLISHABLE_KEY"
};
```

Do not put the service-role key in this file. The publishable/anon key is the
browser key; the SQL file protects the data with Row-Level Security.

## 3. Configure sign-in redirects

In Supabase, open **Authentication > URL Configuration**.

Set the Site URL to the deployed app address and add the same address under
Redirect URLs.

For local testing, also add:

```text
http://localhost:8000/
```

## 4. Test locally

Do not double-click `index.html`. Serve the folder over HTTP.

From inside this folder:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## 5. Put it online

Any static host works, including GitHub Pages, Netlify, Cloudflare Pages or
Supabase Storage with a suitable web-hosting setup.

After deploying, add the final HTTPS address to Supabase's Site URL and Redirect
URLs.

## 6. Start using it

1. Person one signs in and chooses **Create a household**.
2. Open **Household** and copy the invite code.
3. Person two signs in using a different email.
4. Person two chooses **Join a household** and enters the code.
5. Both people can now see and update the same list.

## Phone installation

- Android/Chrome: use the app's **Install** button when shown, or the browser
  menu's **Install app / Add to Home screen** option.
- iPhone/Safari: tap **Share**, then **Add to Home Screen**.

## Important operational rule

Treat this list as the official household memory. When a task changes, update
the task's notes rather than relying on memory or a separate chat thread.
