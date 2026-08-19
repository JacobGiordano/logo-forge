#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

ipset create allowed-domains hash:net

# GitHub IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
    echo "WARNING: Failed to fetch GitHub IP ranges — skipping"
elif ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "WARNING: GitHub API response missing required fields — skipping"
else
    echo "Processing GitHub IPs..."
    while read -r cidr; do
        if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            echo "WARNING: Invalid CIDR range from GitHub meta: $cidr — skipping"
            continue
        fi
        echo "Adding GitHub range $cidr"
        ipset add -exist allowed-domains "$cidr"
    done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)
fi

for domain in \
    "api.anthropic.com" \
    "api.openai.com" \
    "generativelanguage.googleapis.com" \
    "api.x.ai" \
    "api.deepseek.com" \
    "api.mistral.ai" \
    "openrouter.ai" \
    "storage.googleapis.com" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com" \
    "marketplace.visualstudio.com" \
    "vscode.blob.core.windows.net" \
    "update.code.visualstudio.com" \
    "fonts.googleapis.com" \
    "fonts.gstatic.com" \
    "hooks.slack.com" \
    "registry.npmjs.org" \
    "playwright.download.prss.microsoft.com" \
    "cdn.playwright.dev"; do
    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        echo "WARNING: Failed to resolve $domain — skipping"
        continue
    fi
    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "WARNING: Invalid IP for $domain: $ip — skipping"
            continue
        fi
        echo "Adding $ip for $domain"
        ipset add -exist allowed-domains "$ip"
    done < <(echo "$ips")
done

HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "WARNING: Failed to detect host IP — skipping host network rules"
else
    HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
    echo "Host network detected as: $HOST_NETWORK"
    iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
    iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT
fi

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Background daemon to refresh CDN-backed IPs every 30 minutes
nohup bash -c '
CDN_DOMAINS="hooks.slack.com api.openai.com api.anthropic.com openrouter.ai"
while true; do
  sleep 1800
  for domain in $CDN_DOMAINS; do
    ips=$(dig +noall +answer A "$domain" 2>/dev/null | awk '"'"'$4 == "A" {print $5}'"'"')
    while IFS= read -r ip; do
      [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] && \
        ipset add -exist allowed-domains "$ip" 2>/dev/null || true
    done <<< "$ips"
  done
done
' >/var/log/firewall-refresh.log 2>&1 &
disown

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
