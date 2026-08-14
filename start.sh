#!/bin/bash
# Start Xvfb in the background
Xvfb :99 -screen 0 1280x800x24 -ac -nolisten tcp &

# Wait a brief moment for Xvfb to initialize
sleep 1

# Export display variable
export DISPLAY=:99

# Start Node server as PID 1
exec node dist/server.js
