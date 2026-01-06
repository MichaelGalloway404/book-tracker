import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "path";

/* =====================
   CONFIG
===================== */

const JWT_SECRET = process.env.JWT_SECRET;

/* =====================
   DATABASE (PlanetScale)
===================== */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 5,
});

/* =====================
   APP SETUP
===================== */

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use(express.static("public"));

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
   UTILS
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

function getImagesForPage(covers, start, end) {
  return covers.slice(start, end).map(book => ({
    title: book.title || "Unknown Title",
    author: book.author || "Unknown Author",
    coverUrl: book.coverUrl || addBook(book.isbn || ""),
  }));
}

/* =====================
   ROUTES
===================== */

// HOME
app.get("/", async (req, res) => {
  const [rows] = await pool.query("SELECT username FROM users");
  rows.forEach(u => (u.username = u.username.toUpperCase()));
  res.clearCookie("token");
  res.render("index.ejs", { rows });
});

// LOGIN
app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.post("/login", async (req, res) => {
  const { Username, Password } = req.body;

  const [rows] = await pool.query(
    "SELECT id, password FROM users WHERE username = ?",
    [Username]
  );

  if (!rows.length) {
    return res.render("login.ejs", { error: "Invalid credentials" });
  }

  const user = rows[0];
  const match = await bcrypt.compare(Password, user.password);

  if (!match) {
    return res.render("login.ejs", { error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });

  res.redirect("/profile");
});

// SIGN UP
app.get("/signUp", (req, res) => {
  res.render("signUp.ejs");
});

app.post("/signUp", async (req, res) => {
  const { Username, Password, confirmPassword } = req.body;

  if (!Username || Password !== confirmPassword) {
    return res.render("signUp.ejs", { error: "Invalid input" });
  }

  const [existing] = await pool.query(
    "SELECT id FROM users WHERE username = ?",
    [Username]
  );

  if (existing.length) {
    return res.render("signUp.ejs", { error: "Username taken" });
  }

  const hashedPassword = await bcrypt.hash(Password, 10);

  await pool.query(
    "INSERT INTO users (username, password) VALUES (?, ?)",
    [Username, hashedPassword]
  );

  res.render("login.ejs", { message: "Account created. Please log in." });
});

// PROFILE (JWT PROTECTED)
app.get("/profile", requireAuth, async (req, res) => {
  const userId = req.userId;

  const [[user]] = await pool.query(
    "SELECT username FROM users WHERE id = ?",
    [userId]
  );

  const [books] = await pool.query(
    "SELECT title, author, cover_url FROM books WHERE user_id = ?",
    [userId]
  );

  res.render("profile.ejs", {
    listTitle: `${user.username}'s Books`,
    listItems: books,
  });
});

// VIEW OTHER PROFILE
app.post("/profileView", async (req, res) => {
  const [[user]] = await pool.query(
    "SELECT id FROM users WHERE username = ?",
    [req.body.user]
  );

  if (!user) {
    return res.render("profileView.ejs", {
      listTitle: "No Books",
      listItems: [],
    });
  }

  const [books] = await pool.query(
    "SELECT title, author, cover_url FROM books WHERE user_id = ?",
    [user.id]
  );

  res.render("profileView.ejs", {
    listTitle: `${req.body.user}'s Books`,
    listItems: books,
  });
});

// SEARCH
app.post("/search", async (req, res) => {
  const { bookTitle, bookAuthor, index = 0 } = req.body;
  const page = parseInt(index, 10);

  let covers = [];
  if (/^\d{10,13}$/.test(bookTitle?.trim())) {
    covers = [{
      title: `Book with ISBN ${bookTitle}`,
      author: "Unknown Author",
      coverUrl: addBook(bookTitle),
    }];
  } else {
    covers = await getIsbnFromName(bookTitle, bookAuthor);
  }

  const books = getImagesForPage(covers, page, page + 20);

  res.render("bookSelection.ejs", {
    books,
    pageQuantity: page,
    bookTitle,
    bookAuthor,
  });
});

// ADD BOOK (JWT)
app.post("/addBook", requireAuth, async (req, res) => {
  const { title, author, coverUrl } = req.body;

  await pool.query(
    "INSERT INTO books (user_id, title, author, cover_url) VALUES (?, ?, ?, ?)",
    [req.userId, title, author, coverUrl]
  );

  res.redirect("/profile");
});

// DELETE BOOK (JWT)
app.post("/deleteBook", requireAuth, async (req, res) => {
  const { title, author } = req.body;

  await pool.query(
    "DELETE FROM books WHERE user_id = ? AND title = ? AND author = ?",
    [req.userId, title, author]
  );

  res.redirect("/profile");
});

// LOGOUT
app.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/");
});

/* =====================
   EXPORT FOR VERCEL
===================== */

export default app;
