# Docker and Docker Compose

This is the easiest self-hosting path for beginners.

## Before You Start

- Docker Desktop installed and running
- Internet connection (first run downloads the image)

## Step 1: Open the Deploy Folder

```bash
git clone https://github.com/ZeroSum-Solutions/mish.git
cd mish/deploy
```

What this does:
- Downloads the project
- Moves into the folder that contains `docker-compose.yml`

## Step 2: Create `.env` and choose an API auth mode

Create `deploy/.env` from the tracked template:

```bash
cp .env.example .env
```

Generate a token if you want the default protected mode:

```bash
openssl rand -hex 32
```

Then edit `.env` and configure one of these before first start:

- recommended default: paste the generated token into `OD_API_TOKEN=`
- trusted authenticated reverse proxy only: leave `OD_API_TOKEN=` empty and set `MISH_DISABLE_API_AUTH=1`

If you expose Mishh Mashh through a reverse proxy, also set:

```bash
MISH_ALLOWED_ORIGINS=https://yourdomain.com
```

## Step 3: Start Mishh Mashh

```bash
docker compose up -d --build
```

What to expect:
- First run can take 1-2 minutes while Docker builds the image
- You should see container creation and startup messages

## Step 4: Confirm Container Health

```bash
docker compose ps
```

Success looks like:
- `mish` container is listed
- `STATUS` shows `Up` and eventually `healthy`
- Port mapping includes `127.0.0.1:7456->7456/tcp`
- In Docker Desktop, the `mish` container shows as running under the `mish` project

## Step 5: Verify Container Health Over HTTP

```bash
curl -i http://127.0.0.1:7456/api/health
```

Success looks like:
- HTTP status `200 OK` on the first line of the response, followed by a JSON body

## Step 6: Open Mishh Mashh in Your Browser

Open:
- `http://127.0.0.1:7456/`

If the browser displays a sign-in dialog, enter `mish` as the username
and the `OD_API_TOKEN` value from `deploy/.env` as the password. You should then
see the Mishh Mashh interface. Docker bridge peers remain authenticated; no host
networking override is required.

## Common Issues

- `failed to connect to the docker API`: Docker Desktop is not running yet
- `address already in use`: Port `7456` is occupied by another process
- `curl: (7) Failed to connect`: container is still starting; wait 10-20 seconds and retry
- `pull access denied` or `authentication required` for `ghcr.io/zerosum-solutions/mish`: no public image is published. Build it locally with `docker compose build` in `deploy/`.
- reverse proxy + `OD_API_TOKEN`: either inject `Authorization: Bearer <OD_API_TOKEN>` at the proxy, or set `MISH_DISABLE_API_AUTH=1` only when that proxy already authenticates every request and the daemon is not directly exposed.
- browser sign-in repeats: use username `mish` and the exact `OD_API_TOKEN` value from `deploy/.env`; recreate the container after changing the token.

## Other deployment targets

- Cloud guides: [Azure Container Instances](cloud/azure.md) and [Alibaba Cloud](cloud/aliyun.md).
- Vercel cannot host the daemon. The root `vercel.json` deploys only a static UI shell; see [`vercel.md`](vercel.md).
