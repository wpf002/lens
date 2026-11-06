package store

import (
	"database/sql"
	"os/exec"
)

var db *sql.DB

func Find(id string) string {
	rows, _ := db.Query("SELECT body FROM reports WHERE id = " + id)
	defer rows.Close()
	return ""
}

func Archive(name string) {
	exec.Command("sh", "-c", "tar czf /tmp/"+name+".tgz /var/reports").Run()
}
