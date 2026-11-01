"""Small Flask service."""
import pickle
import sqlite3
from flask import Flask, request
from flask_login import login_required

app = Flask(__name__)

@app.route("/items", methods=["POST"])
def create_item():
    data = pickle.loads(request.data)
    return save(data)

@app.route("/items/<name>")
@login_required
def get_item(name):
    cur = sqlite3.connect("x.db").cursor()
    cur.execute(f"SELECT * FROM items WHERE name = '{name}'")
    return str(cur.fetchone())

def save(data):
    return "ok"

if __name__ == "__main__":
    app.run(debug=True)
