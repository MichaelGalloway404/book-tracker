import express from "express";
import axios from "axios";
import { sql } from "@vercel/postgres";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "path";

/* =====================
   CONFIG
===================== */
const JWT_SECRET = process.env.JWT_SECRET;

/* =====================
   APP SETUP
===================== */
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  "/public",
  express.static(path.join(process.cwd(), "public"))
);

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

/* =====================
   AUTH MIDDLEWARE
===================== */
function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect("/");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.clearCookie("token");
    res.redirect("/");
  }
}

/* =====================
   UTILS (OpenLibrary)
===================== */
function addBook(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
}

async function getIsbnFromName(title, author) {
  const covers = [];
  const params = new URLSearchParams();

  if (title) params.append("title", title);
  if (author) params.append("author", author);

  try {
    const response = await axios.get(
      `https://openlibrary.org/search.json?${params.toString()}`
    );

    for (const doc of response.data.docs || []) {
      if (doc.cover_i) {
        covers.push({
          title: doc.title,
          author: (doc.author_name || []).join(", "),
          coverUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`,
          isbn: doc.isbn?.[0] || null,
        });
      }
    }
  } catch (err) {
    console.error("OpenLibrary error:", err.message);
  }

  return covers;
}

/* =====================
   ROUTES
===================== */

// HOME
app.get("/", async (req, res) => {
  const { rows } = await sql`SELECT username FROM users`;
  rows.forEach(u => (u.username = u.username.toUpperCase()));

  res.clearCookie("token");
  res.render("index.ejs", { rows });
});

// LOGIN
// SHOW LOGIN PAGE
app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.post("/login", async (req, res) => {
  const { Username, Password } = req.body;

  const { rows } =
    await sql`SELECT id, password FROM users WHERE username = ${Username}`;

  if (!rows.length || !(await bcrypt.compare(Password, rows[0].password))) {
    return res.render("login.ejs", { error: "Invalid credentials" });
  }

  const token = jwt.sign({ userId: rows[0].id }, JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  res.redirect("/profile");
});

// SIGN UP
// SHOW SIGN UP PAGE
app.get("/signUp", (req, res) => {
  res.render("signUp.ejs");
});

app.post("/signUp", async (req, res) => {
  const { Username, Password, confirmPassword } = req.body;

  if (!Username || Password !== confirmPassword) {
    return res.render("signUp.ejs", { error: "Invalid input" });
  }

  const { rows: existing } =
    await sql`SELECT id FROM users WHERE username = ${Username}`;

  if (existing.length) {
    return res.render("signUp.ejs", { error: "Username taken" });
  }

  const hashedPassword = await bcrypt.hash(Password, 10);

  await sql`
    INSERT INTO users (username, password)
    VALUES (${Username}, ${hashedPassword})
  `;

  res.render("login.ejs", { message: "Account created. Please log in." });
});

// PROFILE
app.get("/profile", requireAuth, async (req, res) => {
  const { rows: userData } =
    await sql`SELECT username FROM users WHERE id = ${req.userId}`;

  const { rows: books } =
    await sql`
      SELECT title, author, cover_url
      FROM books
      WHERE user_id = ${req.userId}
    `;

  res.render("profile.ejs", {
    listTitle: `${userData[0].username}'s Books`,
    listItems: books,
  });
});

// VIEW a users profile not logged in
app.post("/profileView", async (req, res) => {
  const { user } = req.body; // username sent from form

  if (!user) {
    return res.redirect("/");
  }

  // Find user by username
  // const { rows: users } = await sql`SELECT id, username FROM users WHERE username = ${user}`;
  const { rows: users } = await sql`SELECT id, username FROM users WHERE username ILIKE ${user}`;

console.log("user:", user);

  if (users.length === 0) {
    return res.render("profileView.ejs", {
      listTitle: "No Books",
      listItems: [],
    });
  }

  const foundUser = users[0];

  // Fetch that user's books
  const { rows: books } =
    await sql`
      SELECT title, author, cover_url
      FROM books
      WHERE user_id = ${foundUser.id}
    `;

  // Render profile view
  res.render("profileView.ejs", {
    listTitle: `${foundUser.username}'s Books`,
    listItems: books,
  });
});

// SEARCH FOR A BOOK
// Helper function for paging
function getImagesForPage(covers, start, end) {
  return covers.slice(start, end);
}

// search for a book with paging
app.post("/search", async (req, res) => {
  try {
    const { bookTitle = "", bookAuthor = "", index = "0" } = req.body;

    const pageIndex = parseInt(index, 10) || 0; // page offset
    const pageSize = 20;

    let covers = [];
    const trimmedTitle = bookTitle.trim();

    // 1️⃣ Direct ISBN search
    if (/^\d{10,13}$/.test(trimmedTitle)) {
      covers = [{
        title: `Book with ISBN ${trimmedTitle}`,
        author: "Unknown Author",
        coverUrl: addBook(trimmedTitle),
        isbn: trimmedTitle,
      }];
    } else {
      // 2️⃣ Search by title/author using OpenLibrary
      covers = await getIsbnFromName(trimmedTitle, bookAuthor);
    }

    // 3️⃣ Paginate results
    const start = pageIndex * pageSize;
    const end = start + pageSize;
    const books = getImagesForPage(covers, start, end);

    // 4️⃣ Render page
    res.render("bookSelection", {
      books,
      pageQuantity: pageIndex, // current page index
      bookTitle,
      bookAuthor,
      totalPages: Math.ceil(covers.length / pageSize),
    });

  } catch (err) {
    console.error("Error in POST /search:", err);
    res.redirect("/");
  }
});


// ADD BOOK
app.post("/addBook", requireAuth, async (req, res) => {
  const { title, author, coverUrl } = req.body;

  await sql`
    INSERT INTO books (user_id, title, author, cover_url)
    VALUES (${req.userId}, ${title}, ${author}, ${coverUrl})
  `;

  res.redirect("/profile");
});

// DELETE BOOK
app.post("/deleteBook", requireAuth, async (req, res) => {
  const { title, author } = req.body;

  await sql`
    DELETE FROM books
    WHERE user_id = ${req.userId}
      AND title = ${title}
      AND author = ${author}
  `;

  res.redirect("/profile");
});

/* =====================
   EXPORT FOR VERCEL
===================== */
export default app;
