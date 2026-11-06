"""Report queries."""
import sqlite3

def fetch_report(key):
    cur = sqlite3.connect("x.db").cursor()
    cur.execute(f"SELECT * FROM reports WHERE key = '{key}'")
    return str(cur.fetchone())

def fetch_page(page, size=20):
    cur = sqlite3.connect("x.db").cursor()
    cur.execute(f"SELECT * FROM pages LIMIT {size} OFFSET {page}")
    return str(cur.fetchall())
