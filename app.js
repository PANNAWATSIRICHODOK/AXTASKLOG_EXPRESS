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

let axRobot = null;
let retryInterval = null;

const configs = {
  appId: "axbaa72440e6274fd6",
  appSecret: "031f0f38f94c441b85bd46a13b7a0171",
  robotId: "",
  mode: 1, // 1: Prod, -1: Dev
  globalServicePath: "https://apiglobal.autoxing.com/",
  globalWsPath: "wss://serviceglobal.autoxing.com/",
};

// Middleware for parsing JSON and enabling CORS
app.use(express.json());
app.use(cors());

async function fetchCurrentTask() {
  try {
    if (axRobot) {
      const task = await axRobot.getCurrentTask();
      console.log("Fetched Task from SDK:", task);

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
      } else {
        console.log("No task found.");
      }
    }
  } catch (e) {
    console.error("Error fetching current task:", e);
  }
  return null;
}

async function fetchStatisticsTotal() {
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

      // Convert distance metrics to kilometers
      if (result && Array.isArray(result.lists)) {
        result.lists = result.lists.map((item) => ({
          ...item,
          mileage:
            item.mileage !== undefined
              ? (item.mileage / 1000).toFixed(2) + " km"
              : "N/A",
          taskMileage:
            item.taskMileage !== undefined
              ? (item.taskMileage / 1000).toFixed(2) + " km"
              : "N/A",
        }));
      }

      console.log("Fetched Statistics:", result);
      return result;
    }
  } catch (e) {
    console.error("Error fetching statistics total:", e);
  }
  return null;
}

function startRetryingCurrentTaskAndStatistics(res) {
  if (retryInterval) clearInterval(retryInterval);

  retryInterval = setInterval(async () => {
    const currentTask = await fetchCurrentTask();
    const statistics = await fetchStatisticsTotal();

    if (currentTask) {
      clearInterval(retryInterval);
      retryInterval = null;
      console.log("Current Task and Statistics Found:", {
        currentTask,
        statistics,
      });
      res.json({
        message: "Current task and statistics found",
        currentTask,
        statistics,
      });
    } else {
      console.log("Retrying to fetch current task and statistics...");
    }
  }, 3000); // Retry every 3 seconds
}

app.post("/init", async (req, res) => {
  try {
    if (axRobot) axRobot.destroy();

    const { appId, appSecret, mode, globalServicePath, globalWsPath } = configs;

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
    if (isOk) {
      const version = axRobot.getVersion();
      res.json({ message: "Initialization succeeded", sdkVersion: version });
    } else {
      res.status(500).json({ message: "Initialization failed" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/connect", async (req, res) => {
  try {
    console.log("Connecting with Robot ID:", req.body.robotId);
    if (axRobot) axRobot.destroy();

    const { robotId } = req.body;
    configs.robotId = robotId;

    const { appId, appSecret, mode, globalServicePath, globalWsPath } = configs;
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
    console.log("SDK Initialization Status:", isOk);
    if (isOk) {
      const resData = await axRobot.connectRobot({ robotId });
      console.log("Robot Connection Response:", resData);
      if (resData.errCode === 0) {
        startRetryingCurrentTaskAndStatistics(res);
      } else {
        res
          .status(500)
          .json({ message: "Connection failed", error: resData.errMsg });
      }
    } else {
      res.status(500).json({ message: "Initialization failed" });
    }
  } catch (e) {
    console.error("Error during connection:", e);
    res.status(500).json({ error: e.message });
  }
});

// Server Cleanup
process.on("SIGINT", () => {
  if (axRobot) axRobot.destroy();
  if (retryInterval) clearInterval(retryInterval);
  console.log("Server shutting down...");
  process.exit();
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
