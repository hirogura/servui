#!/bin/bash
set -euo pipefail

# --- yes/noプロンプト関数 ---
ask_yn() {
    local prompt="$1"
    local answer
    while true; do
        read -rp "$prompt [y/n]: " answer
        case "$answer" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo "y か n で答えてください。" ;;
        esac
    done
}

sudo timedatectl set-timezone Asia/Tokyo

sudo apt update

# console-setup / keyboard-configuration のdebconf質問を事前回答で回避
sudo debconf-set-selections <<'EOF'
console-setup console-setup/codeset47 select Guess optimal character set
console-setup console-setup/fontface47 select Fixed
console-setup console-setup/fontsize select 16
keyboard-configuration keyboard-configuration/layout select Japanese
keyboard-configuration keyboard-configuration/layoutcode string jp
keyboard-configuration keyboard-configuration/variant select Japanese
EOF

sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y
sudo apt install -y curl
curl -fsSL https://tailscale.com/install.sh | sudo sh

echo ""
if ask_yn "Tailscale の authkey がありますか？"; then
    USE_TS_AUTHKEY=true
else
    USE_TS_AUTHKEY=false
fi
echo ""

if [ "$USE_TS_AUTHKEY" = true ]; then
    # authkey認証に失敗した場合は、別のキー再試行かブラウザ認証かを選択させる
    while true; do
        read -rsp "authkey を入力してください（tskeyから始まる文字列。入力は非表示）: " TS_AUTHKEY
        echo ""
        if [ -z "${TS_AUTHKEY:-}" ]; then
            echo "authkey が空です。もう一度入力してください。"
            continue
        fi
        if sudo tailscale up --authkey="$TS_AUTHKEY"; then
            unset TS_AUTHKEY
            break
        fi
        unset TS_AUTHKEY
        echo ""
        echo "[error] Tailscale の認証に失敗しました（authkey が無効・期限切れの可能性があります）。"
        echo "次の方法を選択してください:"
        echo "  1) 別の Tailscale Auth key を試す"
        echo "  2) 通常の Webブラウザ認証をする"
        choice=""
        while true; do
            read -rp "選択 [1/2]: " choice
            case "$choice" in
                1|2) break ;;
                *) echo "1 か 2 で答えてください。" ;;
            esac
        done
        if [ "$choice" = "2" ]; then
            echo "[info] Webブラウザ認証フローを開始します"
            sudo tailscale up
            break
        fi
        echo "[info] 別の authkey を入力してください"
    done
else
    echo "[info] authkey未入力のためブラウザ認証フローを開始します"
    sudo tailscale up
fi

sudo apt install -y git
if [[ ! -d servui ]]; then
  sudo git clone https://github.com/hirogura/servui.git
else
  echo "[info] ./servui already exists, skipping clone"
fi
cd servui
sudo bash setup.sh
