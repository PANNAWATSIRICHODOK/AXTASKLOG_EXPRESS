const express = require("express");
const cors = require("cors");
const {
  AXRobot: AXRobotProd,
  AppMode: AppModeProd,
} = require("@autoxing/robot-js-sdk");
const {
  AXRobot: AXRobotDev,
  AppMode: AppModeDev,
} = require("@autoxing/robot-js-sdk-dev");

const app = express();
const PORT = 3000;

const predefinedRobots = ["2382310202332BC", "2382310202337BH"];
const robotConnections = new Map();

const configs = {
  appId: "axbaa72440e6274fd6",
  appSecret: "031f0f38f94c441b85bd46a13b7a0171",
  mode: 1,
  globalServicePath: "https://apiglobal.autoxing.com/",
  globalWsPath: "wss://serviceglobal.autoxing.com/",
};

app.use(express.json());
app.use(cors());

async function initializeRobotConnections() {
  for (const robotId of predefinedRobots) {
    try {
      console.log(`Connecting to robot: ${robotId}`);
      const axRobot = await createRobotConnection(robotId);
      robotConnections.set(robotId, axRobot);
      console.log(`Successfully connected to robot: ${robotId}`);
    } catch (error) {
      console.error(`Failed to connect to robot ${robotId}: ${error.message}`);
    }
  }
}

async function fetchCurrentTask(axRobot) {
  try {
    const task = await axRobot.getCurrentTask();
    return task || null;
  } catch (error) {
    console.error("Error fetching current task:", error.message);
    return null;
  }
}

async function fetchSingleTaskStatistics(axRobot, taskId) {
  try {
    if (!taskId) return null;
    const singleTaskStatistics = {
      taskId,
      fields: [
        "cStartTime",
        "cEndTime",
        "mileage",
        "disinfect",
        "taskFinishCount",
        "taskPauseCount",
        "taskCancelCount",
      ],
    };
    const result = await axRobot.getSingleTaskStatistics(singleTaskStatistics);
    return {
      cStartTime: result.cStartTime
        ? new Date(result.cStartTime).toLocaleString()
        : "N/A",
      cEndTime: result.cEndTime
        ? new Date(result.cEndTime).toLocaleString()
        : "N/A",
      mileage: result.mileage
        ? `${(result.mileage / 1000).toFixed(2)} km`
        : "N/A",
      disinfect: result.disinfect || 0,
      taskFinishCount: result.taskFinishCount || 0,
      taskPauseCount: result.taskPauseCount || 0,
      taskCancelCount: result.taskCancelCount || 0,
    };
  } catch (error) {
    console.error("Error fetching single task statistics:", error.message);
    return null;
  }
}

async function createRobotConnection(robotId) {
  const { appId, appSecret, mode, globalServicePath, globalWsPath } = configs;
  let axRobot;

  if (mode === 1 || mode === "1") {
    axRobot = new AXRobotProd(
      appId,
      appSecret,
      AppModeProd.WAN_APP,
      globalServicePath,
      globalWsPath
    );
  } else if (mode === -1 || mode === "-1") {
    axRobot = new AXRobotDev(appId, appSecret, AppModeDev.WAN_APP);
  } else {
    axRobot = new AXRobotProd(appId, appSecret, AppModeProd.WAN_APP);
  }

  const isOk = await axRobot.init();
  if (!isOk) throw new Error("Initialization failed");

  const resData = await axRobot.connectRobot({ robotId });
  if (resData.errCode !== 0) throw new Error(resData.errMsg);

  return axRobot;
}

app.get("/robots", async (req, res) => {
  try {
    const robotsData = [];
    for (const [robotId, axRobot] of robotConnections) {
      const currentTask = await fetchCurrentTask(axRobot);
      const singleTaskStatistics =
        currentTask?.taskId &&
        (await fetchSingleTaskStatistics(axRobot, currentTask.taskId));
      robotsData.push({
        robotId,
        currentTask,
        singleTaskStatistics,
        status: currentTask ? "Active" : "Idle",
      });
    }
    res.json(robotsData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/robots/:robotId", async (req, res) => {
  try {
    const { robotId } = req.params;
    const axRobot = robotConnections.get(robotId);

    if (!axRobot) {
      return res.status(404).json({ error: "Robot not found" });
    }

    const currentTask = await fetchCurrentTask(axRobot);
    const singleTaskStatistics =
      currentTask?.taskId &&
      (await fetchSingleTaskStatistics(axRobot, currentTask.taskId));

    res.json({
      robotId,
      currentTask,
      singleTaskStatistics,
      status: currentTask ? "Active" : "Idle",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

process.on("SIGINT", () => {
  for (const axRobot of robotConnections.values()) {
    axRobot.destroy();
  }
  console.log("Server shutting down...");
  process.exit();
});

initializeRobotConnections().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log("Connected robots:", Array.from(robotConnections.keys()));
  });
});
