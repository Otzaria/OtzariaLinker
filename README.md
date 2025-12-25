# Otzaria Commentary & Links Manager

A lightweight **offline-capable web application** for creating, editing, and managing **commentaries and links** for the **Otzaria** library.

The application runs entirely in your browser using HTML and JavaScript and **does not require any internet connection** once the page is loaded.

---

## What Is This For?

This tool is designed for users who want to:

* Create **new commentaries and links** for books in Otzaria
* Edit or delete **existing commentaries and links**
* Work faster and more comfortably than manual file editing

It visually presents books, commentaries, and links in a way similar to Otzaria itself, but in a simplified interface.

---

## Safety & File Handling

* The application **never modifies Otzaria’s original files directly**
* All changes generate **new files only**
* You choose whether and when to replace Otzaria’s original files
* The app exports modified files as a **ZIP archive**

⚠️ **Important:**
This project is currently **experimental**.
It is strongly recommended to **back up your original Otzaria files** before replacing anything.

---

## How It Works

### Step 1 – Load the Otzaria Folder

Click **“Load Otzaria Folder”** and select the main Otzaria directory, usually:

```
C:\Otzaria
```

Confirm folder access when prompted.

---

### Step 2 – Select a Book

Choose a book from the book list.

---

### Step 3 – Select a Text Segment

Click a text segment in the right panel.

* Existing commentaries and links will appear automatically
* Clicking a commentary or link opens it in the left panel
* You can navigate quickly using the **Table of Contents**

---

### Step 4 – Edit a Commentary or Link

Click the **edit (pencil) icon** next to a commentary or link.

Key concept to understand:

> Otzaria links and commentaries connect **line numbers** from one book to **line numbers** in another book.

You can:

* Manually edit source or target line numbers
* Select new source or target lines visually
* Choose a completely different target book

---

### Step 5 – Save Changes

After selecting the new source or target line, click **Save**.

---

### Step 6 – One-Way or Two-Way Links

When saving, the app will ask whether to:

* Create a **two-way link** (Book A ↔ Book B), like standard Otzaria links
* Or create a **one-way link** only in the current book

Changes appear **immediately** in the interface.

---

### Optional – Create a New Commentary or Link

You can also create new items from scratch:

1. Select a source text segment
2. Click the **plus (+)** button next to Commentaries or Links
3. Choose the target line and target book
4. Save

---

### Step 7 – Export Changes

When finished, click **Export**.

* All modified files are downloaded as a **ZIP archive**
* Extract the files into:

  ```
  C:\Otzaria\links
  ```
* Replace the existing files with the new ones

---

### Step 8 – View the Result in Otzaria

Open Otzaria and enjoy your updated commentaries and links 🎉

---

## Important Notes

* Changes exist **only in memory**
* If you refresh the page or close the browser **without exporting**, all changes are lost
* Always export before closing the app

---

## Technical Overview

* 100% client-side web application
* Runs locally in the browser
* No server, no tracking, no network usage
* Works offline after loading
* Uses Otzaria’s existing file structure and formats

---

## Status

🧪 **Experimental / Beta**

Feedback, testing, and improvements are welcome.
