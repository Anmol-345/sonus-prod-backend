#!/bin/bash
# Start the Python Extractor in the background
python3 python_service.py &

# Start the Node.js Gateway in the foreground
node index.js
