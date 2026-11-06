package main

import (
	"net/http"

	"vulnapp/store"
)

func reportHandler(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	w.Write([]byte(store.Find(id)))
}

func archiveHandler(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	store.Archive(name)
}

func main() {
	http.HandleFunc("/report", reportHandler)
	http.HandleFunc("/archive", archiveHandler)
	http.ListenAndServe(":8080", nil)
}
