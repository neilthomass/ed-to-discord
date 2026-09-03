#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

read_env_value() {
  node -e '
    const fs = require("fs");
    if (!fs.existsSync(".env")) process.exit(0);
    const key = process.argv[1];
    const line = fs.readFileSync(".env", "utf8").split(/\r?\n/)
      .find((item) => item.trim().startsWith(`${key}=`));
    if (!line) process.exit(0);
    let value = line.slice(line.indexOf("=") + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("\x27") && value.endsWith("\x27"))) {
      value = value.slice(1, -1);
    }
    process.stdout.write(value);
  ' "$1"
}

select_courses() {
  local input token index selected_count
  local -a tokens
  selected_courses=()

  for ((index = 0; index < ${#course_ids[@]}; index += 1)); do
    selected_courses[index]=0
  done

  while true; do
    printf "\nAvailable Ed courses:\n"
    for ((index = 0; index < ${#course_ids[@]}; index += 1)); do
      if [ "${selected_courses[index]}" -eq 1 ]; then
        printf "  [x] %2d. %s (course ID %s)\n" "$((index + 1))" "${course_labels[index]}" "${course_ids[index]}"
      else
        printf "  [ ] %2d. %s (course ID %s)\n" "$((index + 1))" "${course_labels[index]}" "${course_ids[index]}"
      fi
    done

    printf "\nToggle by number (for example 1,3), [a]ll, [c]lear, or Enter to confirm: "
    IFS= read -r input

    if [ -z "$input" ]; then
      selected_count=0
      for ((index = 0; index < ${#selected_courses[@]}; index += 1)); do
        if [ "${selected_courses[index]}" -eq 1 ]; then
          selected_count=$((selected_count + 1))
        fi
      done
      if [ "$selected_count" -gt 0 ]; then
        break
      fi
      echo "Select at least one course before confirming."
      continue
    fi

    case "$input" in
      a|A)
        for ((index = 0; index < ${#selected_courses[@]}; index += 1)); do
          selected_courses[index]=1
        done
        continue
        ;;
      c|C)
        for ((index = 0; index < ${#selected_courses[@]}; index += 1)); do
          selected_courses[index]=0
        done
        continue
        ;;
    esac

    IFS=', ' read -r -a tokens <<< "$input"
    for token in "${tokens[@]}"; do
      [ -z "$token" ] && continue
      if [[ ! "$token" =~ ^[0-9]+$ ]] || [ "$token" -lt 1 ] || [ "$token" -gt "${#course_ids[@]}" ]; then
        echo "Ignoring invalid selection: $token"
        continue
      fi
      index=$((token - 1))
      if [ "${selected_courses[index]}" -eq 1 ]; then
        selected_courses[index]=0
      else
        selected_courses[index]=1
      fi
    done
  done

  selected_course_ids=()
  selected_course_labels=()
  for ((index = 0; index < ${#course_ids[@]}; index += 1)); do
    if [ "${selected_courses[index]}" -eq 1 ]; then
      selected_course_ids+=("${course_ids[index]}")
      selected_course_labels+=("${course_labels[index]}")
    fi
  done
}

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing $command_name. Install Node.js 20 or newer, then run this script again." >&2
    exit 1
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

echo "Installing project dependencies..."
npm install

ed_api_token="$(read_env_value ED_API_TOKEN)"
if [ -n "$ed_api_token" ]; then
  echo "Using the Ed API token from the git-ignored .env file."
else
  printf "Ed API token (input hidden): "
  IFS= read -r -s ed_api_token
  printf "\n"
fi
if [ -z "$ed_api_token" ]; then
  echo "The Ed API token cannot be empty." >&2
  exit 1
fi

echo "Loading courses from Ed..."
if ! course_lines="$(printf '%s' "$ed_api_token" | node -e '
  const fs = require("fs");
  const token = fs.readFileSync(0, "utf8");
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

  fetch("https://us.edstem.org/api/user", {
    headers: { Authorization: authorization, Accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Ed returned ${response.status}: ${await response.text()}`);
    return response.json();
  }).then((payload) => {
    const clean = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
    const courses = (payload.courses ?? [])
      .map((entry) => entry.course ?? entry)
      .filter((course) => Number.isInteger(course.id))
      .sort((left, right) => {
        if (left.status === "active" && right.status !== "active") return -1;
        if (left.status !== "active" && right.status === "active") return 1;
        return clean(left.code).localeCompare(clean(right.code));
      });
    for (const course of courses) {
      const status = course.status === "active" ? "active" : clean(course.status || "unknown");
      process.stdout.write(`${course.id}\t${clean(course.code)} — ${clean(course.name)} [${status}]\n`);
    }
  }).catch((error) => {
    console.error(`Could not load Ed courses: ${error.message}`);
    process.exitCode = 1;
  });
')"; then
  exit 1
fi

if [ -z "$course_lines" ]; then
  echo "The Ed account has no available courses." >&2
  exit 1
fi

course_ids=()
course_labels=()
while IFS=$'\t' read -r course_id course_label; do
  [ -z "$course_id" ] && continue
  course_ids+=("$course_id")
  course_labels+=("$course_label")
done <<< "$course_lines"
unset course_lines course_id course_label

select_courses

configured_webhooks="$(read_env_value DISCORD_WEBHOOKS)"
legacy_webhook="$(read_env_value DISCORD_WEBHOOK_URL)"
discord_webhooks="{}"

if [ -n "$configured_webhooks" ] && ! printf '%s' "$configured_webhooks" | node -e '
  const fs = require("fs");
  try {
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") process.exit(1);
  } catch {
    process.exit(1);
  }
'; then
  echo "DISCORD_WEBHOOKS in .env must be a JSON object mapping course IDs to webhook URLs." >&2
  exit 1
fi

echo
echo "Each selected course needs a webhook from its own Discord channel."
for ((index = 0; index < ${#selected_course_ids[@]}; index += 1)); do
  course_id="${selected_course_ids[index]}"
  course_label="${selected_course_labels[index]}"
  course_webhook=""

  if [ -n "$configured_webhooks" ]; then
    course_webhook="$(printf '%s\0%s' "$configured_webhooks" "$course_id" | node -e '
      const fs = require("fs");
      const [json, id] = fs.readFileSync(0, "utf8").split("\0");
      const value = JSON.parse(json)[id];
      if (typeof value === "string") process.stdout.write(value);
    ')"
  elif [ "${#selected_course_ids[@]}" -eq 1 ] && [ -n "$legacy_webhook" ]; then
    course_webhook="$legacy_webhook"
  fi

  if [ -n "$course_webhook" ]; then
    echo "Using the saved Discord webhook for $course_label."
  else
    printf "Discord webhook for %s (input hidden): " "$course_label"
    IFS= read -r -s course_webhook
    printf "\n"
  fi

  if ! printf '%s' "$course_webhook" | node -e '
    const fs = require("fs");
    try {
      const url = new URL(fs.readFileSync(0, "utf8"));
      if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname)) process.exit(1);
    } catch {
      process.exit(1);
    }
  '; then
    echo "The webhook for $course_label must be a valid HTTPS Discord webhook URL." >&2
    exit 1
  fi

  discord_webhooks="$(printf '%s\0%s\0%s' "$discord_webhooks" "$course_id" "$course_webhook" | node -e '
    const fs = require("fs");
    const [json, id, webhook] = fs.readFileSync(0, "utf8").split("\0");
    const value = JSON.parse(json);
    value[id] = webhook;
    process.stdout.write(JSON.stringify(value));
  ')"
done

unset configured_webhooks legacy_webhook course_webhook course_id course_label index
unset selected_courses selected_course_ids selected_course_labels course_ids course_labels

secret_file="$(mktemp "${TMPDIR:-/tmp}/ed-to-discord-secrets.XXXXXX")"
chmod 600 "$secret_file"
trap 'rm -f "$secret_file"' EXIT

printf '%s\0%s' "$ed_api_token" "$discord_webhooks" | node -e '
  const fs = require("fs");
  const [token, webhooks] = fs.readFileSync(0, "utf8").split("\0");
  fs.writeFileSync(process.argv[1], JSON.stringify({ ED_API_TOKEN: token, DISCORD_WEBHOOKS: webhooks }));
' "$secret_file"

unset ed_api_token discord_webhooks

echo "Running tests..."
npm test

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Opening Cloudflare login..."
  npx wrangler login
fi

if node -e 'const c=JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8")); process.exit(c.kv_namespaces?.some(x => x.binding === "LAST_SEEN" && x.id) ? 0 : 1)'; then
  echo "KV namespace is already configured."
else
  echo "Creating the LAST_SEEN KV namespace..."
  npx wrangler kv namespace create LAST_SEEN --update-config
fi

echo "Deploying the Worker, secrets, KV binding, and five-minute cron trigger..."
npx wrangler deploy --secrets-file "$secret_file"

echo
echo "Deployment complete. The first scheduled run seeds the cursor; later runs forward new announcements and staff posts."
