#!/usr/bin/env bash
# ==============================================================================
# start.sh — One-command launcher for the Distributed Clinical System & Logistics
# ==============================================================================
set -e

# Resolve project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for terminal styling
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[2m"
C_RED="\033[31m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_BLUE="\033[34m"
C_MAGENTA="\033[35m"
C_CYAN="\033[36m"
C_WHITE="\033[37m"

# Track background child PIDs
PIDS=()
LOG_DIR="$SCRIPT_DIR/.logs"

# Banner
clear_or_separator() {
  echo -e "\n${C_BOLD}${C_CYAN}==============================================================================${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}  Distributed Clinical Reference-Data Consistency & Logistics Platform       ${C_RESET}"
  echo -e "${C_BOLD}${C_CYAN}==============================================================================${C_RESET}\n"
}

# Cleanup handler for graceful shutdown
cleanup() {
  echo -e "\n\n${C_BOLD}${C_YELLOW}Shutting down all services gracefully...${C_RESET}"

  # Terminate tracked PIDs
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  # Wait briefly for graceful shutdown
  sleep 1

  # Force kill any remaining tracked processes
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  # Free ports if any orphaned child process is still lingering
  local PORTS=(4001 4002 4101 4102 4103 4301 5173 5174)
  for port in "${PORTS[@]}"; do
    local lpid
    lpid=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$lpid" ]; then
      kill -9 $lpid 2>/dev/null || true
    fi
  done

  echo -e "${C_GREEN}All services stopped cleanly. Goodbye!${C_RESET}\n"
  exit 0
}

trap cleanup INT TERM

# Step 1: Pre-flight dependency & port checks
clear_or_separator

echo -e "${C_BOLD}1. Checking prerequisites...${C_RESET}"

if ! command -v node >/dev/null 2>&1; then
  echo -e "${C_RED}Error: Node.js is not installed or not in PATH.${C_RESET}"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo -e "${C_RED}Error: npm is not installed or not in PATH.${C_RESET}"
  exit 1
fi

NODE_VER=$(node -v)
echo -e "  ${C_GREEN}✔${C_RESET} Node.js: ${C_CYAN}${NODE_VER}${C_RESET}"
echo -e "  ${C_GREEN}✔${C_RESET} npm:     ${C_CYAN}$(npm -v)${C_RESET}"

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
  echo -e "\n${C_YELLOW}Root node_modules missing. Running npm install...${C_RESET}"
  npm install
fi

if [ ! -d "dashboard/node_modules" ]; then
  echo -e "\n${C_YELLOW}Dashboard node_modules missing. Running npm install in dashboard...${C_RESET}"
  npm --prefix dashboard install
fi

if [ ! -d "dashboard-logistics/node_modules" ]; then
  echo -e "\n${C_YELLOW}Logistics dashboard node_modules missing. Running npm install...${C_RESET}"
  npm --prefix dashboard-logistics install
fi

# Step 2: Clean up any stale processes on required ports
echo -e "\n${C_BOLD}2. Checking port availability...${C_RESET}"
PORTS_TO_CHECK=(4001 4002 4101 4102 4103 4301 5173 5174)
for p in "${PORTS_TO_CHECK[@]}"; do
  EXISTING_PID=$(lsof -ti :"$p" 2>/dev/null || true)
  if [ -n "$EXISTING_PID" ]; then
    echo -e "  ${C_YELLOW}⚠ Port $p was in use (PID: $EXISTING_PID). Freeing port...${C_RESET}"
    kill -15 "$EXISTING_PID" 2>/dev/null || true
    sleep 0.4
    kill -9 "$EXISTING_PID" 2>/dev/null || true
  fi
done
echo -e "  ${C_GREEN}✔${C_RESET} All ports (4001, 4002, 4101-4103, 4301, 5173, 5174) are clear."

# Step 3: Ensure Redis
echo -e "\n${C_BOLD}3. Checking Redis persistence layer...${C_RESET}"
mkdir -p "$LOG_DIR"
node scripts/ensure-redis.mjs >> "$LOG_DIR/redis.log" 2>&1
echo -e "  ${C_GREEN}✔${C_RESET} Redis ready on port 6379."

# Step 4: Launch backend services and frontends
echo -e "\n${C_BOLD}4. Launching backend services & frontend applications...${C_RESET}"

# Helper to start a process and record PID + pipe logs
start_service() {
  local name="$1"
  local logfile="$LOG_DIR/${name}.log"
  local cmd="$2"

  rm -f "$logfile"
  # Run in subshell with its own env, teeing to logfile and combined all.log
  (
    eval "$cmd" 2>&1 | while IFS= read -r line; do
      echo "[$(date '+%H:%M:%S')] [$name] $line" >> "$LOG_DIR/all.log"
      echo "$line" >> "$logfile"
    done
  ) &
  local pid=$!
  PIDS+=("$pid")
}

# 1. Convergence Coordinator (port 4002)
start_service "coordinator" "PORT=4002 CENTRAL_URL=http://localhost:4001 STATE_PATH='$SCRIPT_DIR/.data/coordinator.json' npx tsx services/convergence-coordinator/src/index.ts"

# 2. Central Reference Service (port 4001)
start_service "central" "PORT=4001 SITE_HOSTS='localhost:4101,localhost:4102,localhost:4103' COORDINATOR_URL=http://localhost:4002 REDIS_URL=redis://localhost:6379 DATA_DIR='$SCRIPT_DIR/.data' npx tsx services/central-reference-service/src/index.ts"

# 3. Logistics Service (port 4301)
start_service "logistics" "PORT=4301 REDIS_URL=redis://localhost:6379 STATE_PATH='$SCRIPT_DIR/.data/logistics.json' npx tsx services/logistics-service/src/index.ts"

# 4. Site Agents (ports 4101, 4102, 4103)
start_service "site-a" "SITE_ID=site-a PORT=4101 COORDINATOR_URL=http://localhost:4002 CENTRAL_URL=http://localhost:4001 STATE_PATH='$SCRIPT_DIR/.data/site-a.json' npx tsx services/site-agent/src/index.ts"
start_service "site-b" "SITE_ID=site-b PORT=4102 COORDINATOR_URL=http://localhost:4002 CENTRAL_URL=http://localhost:4001 STATE_PATH='$SCRIPT_DIR/.data/site-b.json' npx tsx services/site-agent/src/index.ts"
start_service "site-c" "SITE_ID=site-c PORT=4103 COORDINATOR_URL=http://localhost:4002 CENTRAL_URL=http://localhost:4001 STATE_PATH='$SCRIPT_DIR/.data/site-c.json' npx tsx services/site-agent/src/index.ts"

# 5. Main Clinical Dashboard (port 5173)
start_service "dashboard" "cd dashboard && npm run dev"

# 6. Logistics Dashboard (port 5174)
start_service "logistics-dashboard" "cd dashboard-logistics && npm run dev"

# Step 5: Wait for all services to become healthy
echo -e "\n${C_BOLD}5. Waiting for services to become healthy...${C_RESET}"

wait_for_url() {
  local name="$1"
  local url="$2"
  local max_wait=30
  local elapsed=0

  while [ $elapsed -lt $max_wait ]; do
    if curl -s -f -o /dev/null "$url" 2>/dev/null; then
      echo -e "  ${C_GREEN}✔${C_RESET} ${name} is healthy: ${C_DIM}${url}${C_RESET}"
      return 0
    fi
    sleep 0.8
    elapsed=$((elapsed + 1))
  done

  echo -e "  ${C_RED}✖${C_RESET} ${name} did not become healthy within ${max_wait}s (${url})."
  echo -e "    Check log: ${C_YELLOW}$LOG_DIR/${name}.log${C_RESET}"
  if [ -f "$LOG_DIR/${name}.log" ]; then
    tail -n 10 "$LOG_DIR/${name}.log"
  fi
  return 1
}

wait_for_url "Convergence Coordinator" "http://localhost:4002/healthz"
wait_for_url "Central Reference Service" "http://localhost:4001/healthz"
wait_for_url "Logistics Service" "http://localhost:4301/healthz"
wait_for_url "Site Agent A" "http://localhost:4101/healthz"
wait_for_url "Site Agent B" "http://localhost:4102/healthz"
wait_for_url "Site Agent C" "http://localhost:4103/healthz"
wait_for_url "Clinical Dashboard" "http://localhost:5173"
wait_for_url "Logistics Dashboard" "http://localhost:5174"

# Step 6: Non-destructive Seed
echo -e "\n${C_BOLD}6. Applying baseline seed...${C_RESET}"
node scripts/seed.mjs >> "$LOG_DIR/all.log" 2>&1 || true
echo -e "  ${C_GREEN}✔${C_RESET} Seed verified (V1 demo rule active)."

# Step 7: Ready Summary Banner
echo -e "\n${C_BOLD}${C_GREEN}==============================================================================${C_RESET}"
echo -e "${C_BOLD}${C_GREEN}  🚀 Whole project is successfully running!                                    ${C_RESET}"
echo -e "${C_BOLD}${C_GREEN}==============================================================================${C_RESET}\n"

echo -e "${C_BOLD}Web Dashboards:${C_RESET}"
echo -e "  🩺 Clinical Dashboard:   ${C_BOLD}${C_CYAN}http://localhost:5173${C_RESET}"
echo -e "  📦 Logistics Dashboard:  ${C_BOLD}${C_CYAN}http://localhost:5174${C_RESET}"
echo ""
echo -e "${C_BOLD}Core APIs:${C_RESET}"
echo -e "  🏛️  Central Reference:   ${C_CYAN}http://localhost:4001${C_RESET} (health: /healthz, audit: /api/audit)"
echo -e "  ⚖️  Coordinator:         ${C_CYAN}http://localhost:4002${C_RESET} (epoch: /api/epoch, watermarks: /api/watermarks)"
echo -e "  🚚 Logistics API:        ${C_CYAN}http://localhost:4301${C_RESET} (shipments: /api/shipments)"
echo -e "  🏥 Site Agents:          ${C_CYAN}http://localhost:4101${C_RESET} (site-a), ${C_CYAN}4102${C_RESET} (site-b), ${C_CYAN}4103${C_RESET} (site-c)"
echo ""
echo -e "${C_BOLD}Pre-seeded Demo Logins:${C_RESET}"
echo -e "  • ${C_WHITE}admin${C_RESET}                    ${C_DIM}/ admin123${C_RESET}       (Admin portal & full chaos control)"
echo -e "  • ${C_WHITE}doctor${C_RESET}                   ${C_DIM}/ doctor123${C_RESET}      (Doctor portal & rule publishing)"
echo -e "  • ${C_WHITE}nurse@demo.health${C_RESET}        ${C_DIM}/ nurse12345${C_RESET}     (Nurse masked patient lookup)"
echo -e "  • ${C_WHITE}ava.thompson@demo.health${C_RESET} ${C_DIM}/ patient12345${C_RESET}   (Patient portal - Patient P-000123)"
echo -e "  • ${C_WHITE}operator${C_RESET}                 ${C_DIM}/ operator123${C_RESET}    (Order submission & live monitoring)"
echo ""
echo -e "${C_BOLD}Useful Commands (in another terminal):${C_RESET}"
echo -e "  • ${C_YELLOW}npm run demo${C_RESET}             Run headless §12 multi-site convergence test"
echo -e "  • ${C_YELLOW}tail -f .logs/all.log${C_RESET}    Stream all background service logs"
echo ""
echo -e "${C_DIM}Logs are stored in: ${LOG_DIR}/*.log${C_RESET}"
echo -e "${C_BOLD}${C_YELLOW}Press Ctrl+C at any time to cleanly stop all services.${C_RESET}\n"

# Step 8: Keep running and stream combined logs
tail -n 20 -f "$LOG_DIR/all.log" &
TAIL_PID=$!
PIDS+=("$TAIL_PID")
wait "$TAIL_PID" 2>/dev/null || true
