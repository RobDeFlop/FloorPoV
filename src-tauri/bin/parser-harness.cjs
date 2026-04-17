const readline = require("readline");
const vm = require("vm");

global.window = global;
global.document = {};
global.navigator = { userAgent: "" };
global.URLSearchParams = class {
  constructor() {}

  get(key) {
    if (key === "gameContentDetectionEnabled") return "false";
    if (key === "metersEnabled") return "false";
    if (key === "liveFightDataEnabled") return "false";
    if (key === "id") return "1";
    return null;
  }
};
global.location = { search: "" };

window.gameContentDetectionEnabled = false;
window.metersEnabled = false;
window.liveFightDataEnabled = false;
window.setWarningText = (text) => {
  process.stderr.write(`[WARN] ${text}\n`);
};
window.setErrorText = (text) => {
  process.stderr.write(`[ERROR] ${text}\n`);
};
window.sendLogMessage = (...args) => {
  process.stderr.write(`[LOG] ${args.join(" ")}\n`);
};
window.sendEventMessage = () => {};
window.sendToHost = () => {};
window.addEventListener = () => {};
window.postMessage = () => {};

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function startCommandLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    try {
      const command = JSON.parse(line);
      switch (command.action) {
        case "clear-state":
          clearParserState();
          parsedLineCount = 0;
          respond({ ok: true });
          break;
        case "set-start-date":
          logStartDate = logCurrDate = command.startDate;
          respond({ ok: true });
          break;
        case "set-report-code":
          respond({ ok: true });
          break;
        case "parse-lines": {
          for (let i = 0; i < command.lines.length; i += 1) {
            parsedLineCount += 1;
            try {
              parseLogLine(
                command.lines[i],
                command.scanning || false,
                command.selectedRegion || 2,
                command.raidsToUpload || [],
                command.logFilePosition || null,
              );
            } catch (error) {
              respond({
                ok: false,
                error: error.message,
                line: command.lines[i],
                parsedLineCount,
              });
              return;
            }
          }
          respond({ ok: true, parsedLineCount });
          break;
        }
        case "collect-fights": {
          if (command.pushFightIfNeeded) {
            pushLogFight(command.scanningOnly || false);
          }
          logFights.logVersion = logVersion;
          logFights.gameVersion = gameVersion;
          logFights.mythic = mythic;
          logFights.startTime = startTime;
          logFights.endTime = endTime;
          const fights = logFights.fights.map((fight) => ({
            eventCount: fight.eventCount,
            eventsString: fight.eventsString,
          }));
          respond({
            ok: true,
            logVersion,
            gameVersion,
            mythic,
            startTime,
            endTime,
            fights,
          });
          break;
        }
        case "collect-master-info":
          buildActorsString();
          if (typeof buildAbilitiesStringIfNeeded === "function") {
            buildAbilitiesStringIfNeeded();
          }
          buildPetsString();
          respond({
            ok: true,
            lastAssignedActorID,
            actorsString,
            lastAssignedAbilityID,
            abilitiesString,
            lastAssignedTupleID,
            tuplesString,
            lastAssignedPetID,
            petsString,
          });
          break;
        case "clear-fights":
          logFights = { fights: [] };
          scannedRaids = [];
          respond({ ok: true });
          break;
        case "get-parser-version":
          respond({
            ok: true,
            parserVersion: typeof parserVersion !== "undefined" ? parserVersion : "unknown",
          });
          break;
        case "ping":
          respond({ ok: true, pong: true });
          break;
        default:
          respond({ ok: false, error: `Unknown action: ${command.action}` });
      }
    } catch (error) {
      respond({ ok: false, error: error.message, stack: error.stack });
    }
  });
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("readable", function onReadable() {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const firstLine = buffer.slice(0, newlineIndex);
      const remainder = buffer.slice(newlineIndex + 1);
      process.stdin.removeListener("readable", onReadable);
      process.stdin.pause();

      try {
        const payload = JSON.parse(firstLine);
        if (payload.gamedataCode) vm.runInThisContext(payload.gamedataCode);
        if (payload.parserCode) vm.runInThisContext(payload.parserCode);
      } catch (error) {
        respond({ ready: false, error: error.message });
        process.exit(1);
      }

      respond({
        ready: true,
        parserVersion: typeof parserVersion !== "undefined" ? parserVersion : "unknown",
      });

      if (remainder) {
        process.stdin.unshift(Buffer.from(remainder, "utf-8"));
      }
      startCommandLoop();
      return;
    }
  }
});
