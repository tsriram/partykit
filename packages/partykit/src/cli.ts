import { runServer, EdgeRuntime } from "edge-runtime";
import { parse } from "url";
import { WebSocketServer } from "ws";
import httpProxy from "http-proxy";
import express from "express";
import path from "path";
import * as esbuild from "esbuild";
import assert from "assert";
import open from "open";
import * as os from "os";
import * as fs from "fs";
import chalk from "chalk";
import { fetchResult } from "./fetchResult";

// A "room" is a server that is running a script,
// as well as a websocket server distinct to the room.
type Room = {
  http: Awaited<ReturnType<typeof runServer>> & {
    // This... might not even be necessary??
    __server: import("http").Server;
  };
  ws: WebSocketServer;
};

const CONFIG_PATH = path.join(os.homedir(), ".partykit", "config.json");

// A map of room names to room servers.
type Rooms = Map<string, Room>;

const GITHUB_APP_ID = "670a9f76d6be706f5209";

export async function dev(
  script: string, // The path to the script that will be run in the room.
  options: { port?: number } = {}
): Promise<{ close: () => Promise<void> }> {
  if (!script) throw new Error("script path is missing");
  // TODO: live reload the script on changes
  const absoluteScriptPath = path.resolve(process.cwd(), script);
  const initialCode = esbuild.buildSync({
    stdin: {
      contents: `
      import * as Worker from "${absoluteScriptPath}"
      addEventListener('fetch', event => {
        return event.respondWith(new Response('Hello world from the room'));
      })
      wss.on("connection", Worker.connect);  
    `,
      resolveDir: process.cwd(),
      // sourcefile: "./" + path.relative(process.cwd(), scriptPath),
    },
    format: "esm",
    bundle: true,
    write: false,
    sourcemap: true,
    target: "esnext",
  }).outputFiles[0].text;

  // A map of room names to room servers.
  const rooms: Rooms = new Map();

  // This is the function that gets/creates a room server.
  async function getRoom(roomId: string): Promise<Room> {
    if (rooms.has(roomId)) {
      return rooms.get(roomId)!;
    }

    const wss = new WebSocketServer({ noServer: true });

    const runtime = new EdgeRuntime({
      initialCode,
      extend: (context) =>
        Object.assign(context, {
          wss,
        }),
    });

    const roomHttpServer = (await runServer({ runtime })) as Room["http"];

    const room = { http: roomHttpServer, ws: wss };
    rooms.set(roomId, room);
    return room;
  }

  const app = express();

  // what we use to proxy requests to the room server
  const proxy = httpProxy.createProxyServer();

  // TODO: maybe we can just use urlpattern here
  app.get("/party/:roomId", async (req, res) => {
    const room = await getRoom(req.params.roomId);

    proxy.web(req, res, {
      target: room.http.url,
    });
  });

  const port = options.port || 1999;

  const server = app.listen(port);
  await new Promise((resolve) => server.once("listening", resolve));

  server.on("upgrade", async function upgrade(request, socket, head) {
    assert(request.url, "request url is missing");
    const { pathname } = parse(request.url);
    assert(pathname, "pathname is missing!");

    // TODO: maybe we can just use urlpattern here
    if (pathname.startsWith("/party/")) {
      const roomId = pathname.split("/")[2];
      const room = await getRoom(roomId);

      room.ws.handleUpgrade(request, socket, head, function done(ws) {
        room.ws.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  console.log(`Listening on http://localhost:${port}...`);

  return {
    async close() {
      // cleanup
      const ctr = rooms.size * 2 + 1;
      return new Promise((resolve, reject) => {
        let count = 0;
        function done(err?: Error) {
          if (err) {
            reject(err);
            return;
          }
          count++;
          if (count === ctr) {
            resolve(undefined);
          }
        }
        // proxy.close(done);
        server.close(done);
        rooms.forEach((room) => {
          // TODO: bleh we should fix server.close() signature upstream
          room.http.__server.close(done);
          room.ws.close(done);
        });
      });
    },
  };
}

type User = {
  login: string;
  access_token: string;
  type: "github";
};

async function getUser(): Promise<User> {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_LOGIN) {
    return {
      login: process.env.GITHUB_LOGIN,
      access_token: process.env.GITHUB_TOKEN,
      type: "github",
    };
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    await login();
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("login failed");
  }
  // TODO: zod
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as User;
  return config;
}

export async function publish(
  scriptPath: string,
  options: { name: string }
): Promise<void> {
  if (!scriptPath) throw new Error("script path is missing");
  if (!options.name) throw new Error("name is missing");

  // get user details
  const user = await getUser();

  const absoluteScriptPath = path.resolve(process.cwd(), scriptPath);
  const code = esbuild.buildSync({
    entryPoints: [absoluteScriptPath],
    format: "esm",
    bundle: true,
    write: false,
    // sourcemap: true,
    target: "esnext",
  }).outputFiles[0].text;

  await fetchResult(`/parties/${user.login}/${options.name}`, {
    method: "POST",
    body: code,
    headers: {
      Authorization: `Bearer ${user.access_token}`,
      "X-PartyKit-User-Type": user.type,
    },
  });

  console.log(
    `Published ${scriptPath} as https://${options.name}.${user.login}.partykit.dev`
  );
}

export async function _delete(options: { name: string }) {
  if (!options.name) throw new Error("name is missing");
  // get user details
  const user = await getUser();

  await fetchResult(`/parties/${user.login}/${options.name}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${user.access_token}`,
    },
  });

  console.log(`Deleted https://${options.name}.${user.login}.partykit.dev`);
}

export async function login(): Promise<void> {
  // see if we already have a code
  if (fs.existsSync(CONFIG_PATH)) {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as User;
    // test if code is valid
    const res = await fetch(`https://api.github.com/user`, {
      headers: {
        Authorization: `Bearer ${user.access_token}`,
      },
    });
    if (res.ok && user.login && (await res.json()).login === user.login) {
      console.log(`Logged in as ${user.login}`);
      return;
    } else {
      console.warn("invalid token detected, logging in again");
      // delete the existing config file
      fs.rmSync(CONFIG_PATH);
    }
  }

  // run github's oauth device flow
  // https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps#device-flow
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_APP_ID,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to get device code: ${res.status} ${res.statusText}`
    );
  }

  const { device_code, user_code, verification_uri, expires_in, interval } =
    await res.json();

  console.log(
    `Please visit ${chalk.bold(
      verification_uri
    )} and paste the code ${chalk.bold(user_code)}`
  );
  console.log(`This code will expire in ${expires_in} seconds`);
  console.log(`Waiting for you to authorize...`);

  // we do this because for some reason the clipboardy package doesn't work
  // with a direct import up top
  const { default: clipboardy } = await import("clipboardy");
  clipboardy.writeSync(user_code);

  open(verification_uri);

  const start = Date.now();
  while (Date.now() - start < expires_in * 1000) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_APP_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Failed to get access token: ${res.status} ${res.statusText}`
      );
    }

    const { access_token, error } = await res.json();

    // now get the username
    const githubUserDetails = (await (
      await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json()) as { login: string };

    if (access_token) {
      // now write the token to the config file at ~/.partykit/config.json
      fs.mkdirSync(path.join(os.homedir(), ".partykit"), { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify(
          { access_token, login: githubUserDetails.login, type: "github" },
          null,
          2
        )
      );
      console.log(`Logged in as ${chalk.bold(githubUserDetails.login)}`);
      return;
    }
    if (error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }
    throw new Error(`Unexpected error: ${error}`);
  }
}

export async function logout() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.rmSync(CONFIG_PATH);
  }
  // TODO: delete the token from github
  console.log("Logged out");
}