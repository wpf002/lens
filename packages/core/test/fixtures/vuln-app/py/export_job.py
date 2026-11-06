"""Export worker."""
import subprocess

def run_export(fmt):
    return subprocess.run(f"convert report.html report.{fmt}", shell=True)
