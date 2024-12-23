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

// Utility functions
function runTypeDescription(runType) {
  const descriptions = {
    0: "Timed Disinfecting",
    1: "Temporary Disinfecting",
    20: "Fast Meal Delivery",
    21: "Multi-Point Meal Delivery",
    22: "Leading",
    23: "Cruising",
    24: "Returning",
    25: "Returning to Pile Charging",
  };
  return descriptions[runType] || "Unknown";
}

function taskTypeDescription(taskType) {
  const descriptions = {
    0: "Disinfect",
    1: "Recharge Pile",
    2: "Restaurant",
  };
  return descriptions[taskType] || "Unknown";
}

async function fetchCurrentTask() {
  try {
    if (axRobot) {
      const task = await axRobot.getCurrentTask();
      if (task && task.taskId) {
        console.log("Current Task:", task);
        stopRetryingTask(); // หยุดดึงข้อมูลเมื่อเจอ Task
        return task; // ส่งกลับ Task ที่พบ
      } else {
        console.log("No current task found. Retrying...");
      }
    }
  } catch (e) {
    console.error("Failed to fetch current task:", e);
  }
}

function startRetryingTask() {
  stopRetryingTask(); // เคลียร์ Interval เดิมถ้ามี
  retryInterval = setInterval(async () => {
    const task = await fetchCurrentTask();
    if (task) {
      console.log("Task Found:", task);
    }
  }, 3000); // ดึงข้อมูลทุก 3 วินาที
}

function stopRetryingTask() {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}

// API Endpoints

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
    if (isOk) {
      const resData = await axRobot.connectRobot({ robotId });
      if (resData.errCode === 0) {
        startRetryingTask();
        res.json({ message: "Connection succeeded", robotId: resData.robotId });
      } else {
        res
          .status(500)
          .json({ message: "Connection failed", error: resData.errMsg });
      }
    } else {
      res.status(500).json({ message: "Initialization failed" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/current-task", async (req, res) => {
  try {
    if (!axRobot)
      return res
        .status(400)
        .json({ message: "SDK not initialized. Call /init first." });

    const task = await axRobot.getCurrentTask();
    if (task && task.taskId) {
      // คำนวณเวลาที่ใช้ใน Task
      const currentTime = Date.now();
      const taskTime = task.createTime
        ? `${Math.floor((currentTime - task.createTime) / 1000)} seconds`
        : "N/A";

      // คำนวณระยะทางรวมจาก taskPts
      const totalDistance = calculateTotalDistance(task.taskPts || []);

      res.json({
        taskId: task.taskId,
        taskName: task.name || "Unnamed Task",
        robotId: task.robotId,
        taskType: taskTypeDescription(task.taskType),
        runType: runTypeDescription(task.runType),
        isCancel: task.isCancel,
        isFinish: task.isFinish,
        totalDistance: `${totalDistance.toFixed(2)} meters`,
        taskDuration: taskTime,
      });
    } else {
      res.status(404).json({ message: "No current task found." });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ฟังก์ชันคำนวณระยะทางรวม
function calculateTotalDistance(taskPts) {
  if (!Array.isArray(taskPts) || taskPts.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 0; i < taskPts.length - 1; i++) {
    const pt1 = taskPts[i];
    const pt2 = taskPts[i + 1];
    const distance = Math.sqrt(
      Math.pow(pt2.x - pt1.x, 2) + Math.pow(pt2.y - pt1.y, 2)
    );
    totalDistance += distance;
  }
  return totalDistance;
}

app.get("/task-statistics", async (req, res) => {
  try {
    if (!axRobot) {
      return res.status(400).json({
        message: "SDK not initialized. Call /init first.",
      });
    }

    const taskId = req.query.taskId;
    const fields = Array.isArray(req.query.fields)
      ? req.query.fields
      : req.query.fields
      ? req.query.fields.split(",")
      : [
          "cStartTime",
          "cEndTime",
          "mileage",
          "disinfect",
          "taskCancelCount",
          "errCount",
          "taskFinishCount",
          "taskPauseCount",
        ];

    const validFields = [
      "cStartTime",
      "cEndTime",
      "mileage",
      "disinfect",
      "taskCancelCount",
      "errCount",
      "taskFinishCount",
      "taskPauseCount",
    ];

    const invalidFields = fields.filter(
      (field) => !validFields.includes(field)
    );

    if (!taskId) {
      return res.status(400).json({
        message: "Missing required parameter: taskId",
      });
    }

    if (invalidFields.length > 0) {
      return res.status(400).json({
        message: `Invalid fields provided: ${invalidFields.join(", ")}`,
      });
    }

    const taskStatistics = { taskId, fields };

    console.log("Task Statistics Parameters:", taskStatistics);

    try {
      const result = await axRobot.getTaskStatistics(taskStatistics);

      console.log("Task Statistics Result (Logged):", result);

      if (!result || Object.keys(result).length === 0) {
        console.log("Debug: No statistics found for:", taskStatistics);
        return res.status(404).json({
          message: "No statistics data found for the given parameters.",
        });
      }

      res.json({ statistics: result });
    } catch (sdkError) {
      console.error("SDK Error fetching task statistics:", sdkError);
      return res.status(500).json({
        message: "Error fetching task statistics from SDK",
        error: sdkError.message || sdkError,
      });
    }
  } catch (e) {
    console.error("Error fetching task statistics:", e);
    res.status(500).json({
      error: e.message,
      message: "An error occurred while fetching task statistics.",
    });
  }
});

// Server Cleanup
process.on("SIGINT", () => {
  if (axRobot) axRobot.destroy();
  stopRetryingTask();
  console.log("Server shutting down...");
  process.exit();
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
