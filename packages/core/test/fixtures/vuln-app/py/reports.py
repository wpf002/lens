"""Report routes."""
from flask import Flask, request
from report_store import fetch_report, fetch_page
from export_job import run_export

app = Flask(__name__)

@app.route("/reports/<key>")
def show_report(key):
    return fetch_report(key)

@app.route("/reports/<key>/raw")
def raw_report(key):
    return fetch_report(key)

@app.route("/reports/<key>/page")
def show_page(key):
    return fetch_page(page=int(key))

@app.route("/exports", methods=["POST"])
def start_export():
    fmt = request.args.get("fmt")
    return run_export(fmt)
