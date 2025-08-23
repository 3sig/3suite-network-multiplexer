import config from "3lib-config";
import cors from "cors";
import process from "process";
import express from "express";
import multer from "multer";
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

config.init();

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();

let serverConnectionCount = [];
let requestQueue = [];

for (let _ of config.get("destinationServers", [])) {
  serverConnectionCount.push(0);
}

app.use(upload.any());
app.use(express.json({ limit: "500mb" })); // for parsing application/json
app.use(express.urlencoded({ limit: "500mb" }));
app.use(cors());

async function executeRequest(req, res, serverIndex, method) {
  serverConnectionCount[serverIndex] += 1;

  try {
    const targetUrl = config.get("destinationServers")[serverIndex] + req.url;
    console.log(`Request ${method} ${req.url} → ${config.get("destinationServers")[serverIndex]}`);
    if (config.get("verbose")) {
      console.log(`Full target URL: ${targetUrl}`);
      console.log(`Headers: ${JSON.stringify(req.headers)}`);
      console.log(`Body keys: ${req.body ? Object.keys(req.body) : 'none'}`);
      console.log(`Server connection count: ${serverConnectionCount[serverIndex]}`);
    }
    let modifiedHeaders = { ...req.headers };

    delete modifiedHeaders["content-length"];
    delete modifiedHeaders["3suite-bundle-id"];
    delete modifiedHeaders["3suite-bundle-size"];
    delete modifiedHeaders["3suite-bundle-order"];
    delete modifiedHeaders["3suite-priority"];

    let params = {
      method: method,
      headers: modifiedHeaders,
    };

    if (method == "POST" || method == "PUT") {
      let contentType = req.headers["content-type"];

      if (contentType && contentType.startsWith("application/json")) {
        // Handle JSON data
        let modifiedBody = {};
        for (let key of Object.keys(req.body)) {
          modifiedBody[key] = req.body[key];
        }
        params.body = JSON.stringify(modifiedBody);
        params.headers["content-type"] = contentType;
      } else if (contentType && contentType.startsWith("multipart/form-data")) {
        // Handle multipart form data
        delete params.headers["content-type"];
        let formData = new FormData();

        // Add form fields
        for (let key in req.body) {
          formData.append(key, req.body[key]);
        }

        // Add files
        if (req.files && req.files.length > 0) {
          for (let file of req.files) {
            formData.append(
              file.fieldname,
              new Blob([file.buffer], { type: file.mimetype }),
              file.originalname,
            );
          }
        }
        params.body = formData;

      } else {
        // send whatever we get if we can't figure out what it is
        if (req.body) {
          if (typeof req.body === "object") {
            // For safety, stringify objects
            params.body = JSON.stringify(req.body);
          }
          else {
            params.body = req.body;
          }
          if (contentType) params.headers["content-type"] = contentType;
        }
      }
    }

    let response = await fetch(
      "http" +
        (config.get("useHttps", false) ? "s" : "") +
        "://" +
        config.get("destinationServers")[serverIndex] +
        req.url,
      params,
    );

    // Copy response headers to our response
    response.headers.forEach((value, key) => {
      // Skip certain headers that Express will set
      if (
        !["connection", "content-length", "transfer-encoding", "content-encoding"].includes(
          key.toLowerCase(),
        )
      ) {
        res.setHeader(key, value);
      }
    });

    // Set the status code from the original response
    res.status(response.status);

    // Send the response body
    const data = await response.arrayBuffer();
    res.send(Buffer.from(data));

    // handle errors in request
  } catch (e) {
    console.log(`Request failed: ${method} ${req.url} - ${e.message}`);
    if (config.get("verbose")) {
      console.log(`Error details: ${e.name}`);
      console.log(`Stack trace: ${e.stack}`);
      console.log(`Server index: ${serverIndex}`);
    }

    // Determine appropriate status code
    let statusCode = 500;
    if (e.name === "AbortError") {
      statusCode = 504; // Gateway Timeout
    } else if (e.name === "TypeError" && e.message.includes("fetch")) {
      statusCode = 502; // Bad Gateway
    }

    // Set appropriate content type based on Accept header
    const acceptHeader = req.headers.accept || "";
    if (acceptHeader.includes("application/json")) {
      res.status(statusCode).json({
        error: true,
        message: "An error occurred while processing your request",
        status: statusCode,
      });
    } else {
      res
        .status(statusCode)
        .send(
          `Error: An error occurred while processing your request (${statusCode})`,
        );
    }
  }
  serverConnectionCount[serverIndex] -= 1;
}

function getAvailableServerIndex() {
  let minimum = config.get("maximumRequestsPerServer", 1);
  let minimumIndex = -1;
  let minimumIndices = [];
  for (let i = 0; i < serverConnectionCount.length; i++) {
    if (config.get("randomizeDestinationServer", false)) {
      if (serverConnectionCount[i] < minimum) {
        minimum = serverConnectionCount[i];
        minimumIndices = [];
      }
      if (serverConnectionCount[i] == minimum) {
        minimumIndices.push(i);
      }
    } else {
      if (serverConnectionCount[i] < minimum) {
        minimum = serverConnectionCount[i];
        minimumIndex = i;
      }
    }
  }

  if (
    config.get("randomizeDestinationServer", false) &&
    minimumIndices.length > 0
  ) {
    minimumIndex =
      minimumIndices[Math.floor(Math.random() * minimumIndices.length)];
  }

  return minimumIndex;
}

let waitingForDebounce = 0;
function addToQueue(callback) {
  requestQueue.push(callback);

  // this debounce logic prevents the processing of requests
  // immediately, waiting instead for a configurable amount of time.
  // this gives clients time to send in higher priority requests
  // before starting long jobs.
  //
  // we keep track of how many requests triggered debounce logic
  // to make sure we spawn enough processQueue calls
  if (!waitingForDebounce) {
    waitingForDebounce = 1;
    (async () => {
      await sleep(config.get("requestDebounceTime", 0));
      for (; waitingForDebounce > 0;  waitingForDebounce--) {
        processQueue();
      }
      waitingForDebounce = 0;
    })();
  }
  else {
    waitingForDebounce += 1;
  }
}

// be very careful modifying this function.
// because of how it returns if all servers are busy,
// there ends up being up to as many processQueue calls
// running as there are available connections
// (e.g. number of servers * number of connections per server)
//
// we assume that IF there is request still in the queue
// when processQueue returns, that means that other
// processQueue calls are waiting for their requests to finish
// and will pick up the remaining calls.
async function processQueue() {
  while (requestQueue.length > 0) {
    let serverIndex = getAvailableServerIndex();
    if (serverIndex < 0) return;

    // because requests are added to the back of the list
    // and it is iterated from the front, this loop chooses
    // the FIRST and HIGHEST PRIORITY request in the queue to process
    let connectionIndex = 0;
    let priority = -1;
    for (let i = 0; i < requestQueue.length; i++) {
      let connectionPriority = requestQueue[i].priority;
      if (connectionPriority > priority) {
        connectionIndex = i;
        priority = connectionPriority;
      }
    }

    let callback = requestQueue.splice(connectionIndex, 1)[0].callback;
    await callback(serverIndex);
  }
}

let bundledRequests = {};

function handleRequest(req, res, method) {
  let serverConnection = {
    callback: async (serverIndex) => {
      await executeRequest(req, res, serverIndex, method);
    },
  };

  serverConnection.priority = parseInt(req.headers["3suite-priority"] || "0");

  if (req.headers["3suite-bundle-id"]) {
    let bundleId = req.headers["3suite-bundle-id"];
    if (!bundledRequests[bundleId]) {
      bundledRequests[bundleId] = [];
    }


    let bundleOrder = req.headers["3suite-bundle-order"]
      ? parseInt(req.headers["3suite-bundle-order"])
      : null;
    serverConnection.bundleOrder = bundleOrder;

    // sort the bundled request by its bundleOrder
    if (serverConnection.bundleOrder != null) {
      let insertionFound = false;
      for (let i = 0; i < bundledRequests[bundleId].length; i++) {
        if (config.get("verbose")) {
          console.log(`Bundle ${bundleId}: comparing order ${bundledRequests[bundleId][i].bundleOrder} vs ${serverConnection.bundleOrder}`);
        }
        if (
          bundledRequests[bundleId][i].bundleOrder >
          serverConnection.bundleOrder
        ) {
          bundledRequests[bundleId].splice(i, 0, serverConnection);
          insertionFound = true;
          break;
        }
      }
      if (!insertionFound) {
        bundledRequests[bundleId].push(serverConnection);
      }
    } else {
      bundledRequests[bundleId].push(serverConnection);
    }

    // TODO: setup timeouts for bundles to clear them from the server
    if (config.get("verbose")) {
      console.log(`Bundle ${bundleId}: added request (${bundledRequests[bundleId].length}/${bundleSize})`);
    }

    let bundleSize = parseInt(req.headers["3suite-bundle-size"] || "0");
    if (bundledRequests[bundleId].length == bundleSize) {
      console.log(`Bundle complete: ${bundleId} (${bundleSize} requests) queued with priority ${serverConnection.priority}`);
      if (config.get("verbose")) {
        console.log(`Bundle ${bundleId} request URLs: ${bundledRequests[bundleId].map((req, i) => `${i}: order ${req.bundleOrder}`).join(', ')}`);
      }
      addToQueue({
        callback: async (serverIndex) => {
          for (let i = 0; i < bundledRequests[bundleId].length; i++) {
            await bundledRequests[bundleId][i].callback(serverIndex);
          }
          delete bundledRequests[bundleId];
        },
        priority: serverConnection.priority,
      });
    }
  } else {
    console.log(`Request queued: ${method} ${req.url} (priority: ${serverConnection.priority})`);
    if (config.get("verbose")) {
      console.log(`Queue length: ${requestQueue.length + 1}`);
      console.log(`Server connection counts: [${serverConnectionCount.join(', ')}]`);
    }
    addToQueue(serverConnection);
  }
}

app.post("*", (req, res) => {
  handleRequest(req, res, "POST");
});

app.get("*", (req, res) => {
  handleRequest(req, res, "GET");
});

app.put("*", (req, res) => {
  handleRequest(req, res, "PUT");
});

app.options("*", (req, res) => {
  handleRequest(req, res, "OPTIONS");
});

let port = config.get("port", 3000);
app.listen(port, () => {
  console.log(`3suite-network-multiplexer started on port ${port}`);
  console.log(`Destination servers: ${config.get("destinationServers").join(', ')}`);
  if (config.get("verbose")) {
    console.log(`Max requests per server: ${config.get("maximumRequestsPerServer", 1)}`);
    console.log(`Randomize server selection: ${config.get("randomizeDestinationServer", false)}`);
    console.log(`Request debounce time: ${config.get("requestDebounceTime", 0)}ms`);
    console.log(`HTTPS enabled: ${config.get("useHttps", false)}`);
    console.log(`Verbose logging: enabled`);
  }
});
