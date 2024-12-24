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

// Predefined robot IDs
const predefinedRobots = ["2382310202337BH"];

// Store multiple robot connections
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

// Initialize connections for all predefined robots on startup
async function initializeRobotConnections() {
  for (const robotId of predefinedRobots) {
    try {
      const axRobot = await createRobotConnection(robotId);
      robotConnections.set(robotId, axRobot);
      console.log(`Successfully connected to robot: ${robotId}`);
    } catch (error) {
      console.error(`Failed to connect to robot ${robotId}:`, error.message);
    }
  }
}

async function fetchCurrentTask(axRobot) {
  try {
    if (axRobot) {
      const task = await axRobot.getCurrentTask();
      if (task && task.taskId) {
        return {
          robotId: task.robotId || "N/A",
          isExecuted: task.isExcute || false,
          createTime: task.createTime
            ? new Date(task.createTime).toLocaleString()
            : "N/A",
          taskId: task.taskId || "N/A",
          taskName: task.name || "N/A",
        };
      }
    }
  } catch (e) {
    console.error("Error fetching current task:", e);
  }
  return null;
}

async function fetchStatisticsTotal(axRobot) {
  try {
    if (axRobot) {
      const statisticsTotal = {
        startTime: Date.now() - 86400000 * 31, // 31 days ago
        endTime: Date.now(),
        dataItems: [
          "taskFinishCount",
          "taskMileage",
          "taskCount",
          "mileage",
          "low20BatCount",
          "emergencyCount",
          "gohomeCount",
        ],
      };

      const result = await axRobot.getStatisticsTotal(statisticsTotal);
      if (result && Array.isArray(result.lists)) {
        result.lists = result.lists.map((item) => ({
          date: new Date(item.date).toLocaleDateString(), // Format date
          taskFinishCount: item.taskFinishCount || 0,
          taskCount: item.taskCount || 0,
          mileage: item.mileage
            ? (item.mileage / 1000).toFixed(2) + " km"
            : "N/A",
          taskMileage: item.taskMileage
            ? (item.taskMileage / 1000).toFixed(2) + " km"
            : "N/A",
          low20BatCount: item.low20BatCount || 0,
          emergencyCount: item.emergencyCount || 0,
          gohomeCount: item.gohomeCount || 0,
        }));
      }
      return result;
    }
  } catch (e) {
    console.error("Error fetching statistics total:", e);
  }
  return null;
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

// Get all robots data
app.get("/robots", async (req, res) => {
  try {
    const robotsData = [];
    for (const [robotId, axRobot] of robotConnections) {
      const currentTask = await fetchCurrentTask(axRobot);
      const statistics = await fetchStatisticsTotal(axRobot);
      robotsData.push({
        robotId,
        currentTask,
        statistics,
        status: currentTask ? "Active" : "Idle",
      });
    }
    res.json(robotsData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get specific robot data
app.get("/robots/:robotId", async (req, res) => {
  try {
    const { robotId } = req.params;
    const axRobot = robotConnections.get(robotId);

    if (!axRobot) {
      return res.status(404).json({ error: "Robot not found" });
    }

    const currentTask = await fetchCurrentTask(axRobot);
    const statistics = await fetchStatisticsTotal(axRobot);

    res.json({
      robotId,
      currentTask,
      statistics,
      status: currentTask ? "Active" : "Idle",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

process.on("SIGINT", () => {
  for (const axRobot of robotConnections.values()) {
    axRobot.destroy();
  }
  console.log("Server shutting down...");
  process.exit();
});

// Initialize connections and start server
initializeRobotConnections().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log("Connected robots:", Array.from(robotConnections.keys()));
  });
});
