import os
from flask import Flask

app = Flask(__name__)


@app.route("/health")
def health():
    return {"ok": True}


@app.get("/greeting")
def greeting():
    return {"hello": os.environ.get("GREETING_NAME", "world")}
