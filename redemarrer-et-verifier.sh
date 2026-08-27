#!/bin/bash
# Redemarre claude-proxy hors de son propre cgroup, puis verifie que Chrome et le
# demon OpenCLI ont survecu (c'etait le defaut de KillMode=mixed).
# Lance par systemd-run pour ne pas mourir avec le service qu'il redemarre.
LOG=/tmp/claude-proxy-redemarrage.log
{
  echo "=== $(date -Is) ==="
  echo "avant  : chrome=$(pgrep -cf 'opt/google/chrome/chrome') proc, opencli=$(pgrep -cf 'opencli/dist/src/daemon.js') proc"

  systemctl --user daemon-reload
  systemctl --user restart claude-proxy
  sleep 6

  echo "etat   : $(systemctl --user is-active claude-proxy)"
  echo "apres  : chrome=$(pgrep -cf 'opt/google/chrome/chrome') proc, opencli=$(pgrep -cf 'opencli/dist/src/daemon.js') proc"
  echo "sante  : $(curl -s --max-time 10 http://localhost:8000/health || echo INJOIGNABLE)"
  echo "--- journal ---"
  journalctl --user -u claude-proxy -n 6 --no-pager -o cat
  echo
} >>"$LOG" 2>&1
