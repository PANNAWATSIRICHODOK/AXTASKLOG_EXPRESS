const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const util = require("util");
const {
  AXRobot: AXRobotProd,
  AppMode: AppModeProd,
} = require("@autoxing/robot-js-sdk");
const {
  AXRobot: AXRobotDev,
  AppMode: AppModeDev,
} = require("@autoxing/robot-js-sdk-dev");

// Configuration
const config = {
  port: process.env.PORT || 3000,
  database: "robot_logs.db",
  robots: {
    predefinedIds: [
      "2382310202342BM",
      "2382310202339BJ",
      "2682406203415T5",
      "2382310202337BH",
      "2382310202332BC",
      "2382310202336BG",
    ],
    api: {
      appId: "axbaa72440e6274fd6",
      appSecret: "031f0f38f94c441b85bd46a13b7a0171",
      mode: 1,
      globalServicePath: "https://apiglobal.autoxing.com/",
      globalWsPath: "wss://serviceglobal.autoxing.com/",
    },
  },
};

// Database initialization
class Database {
  constructor(dbPath) {
    this.db = new sqlite3.Database(dbPath);
    this.initializeSchema();
  }

  initializeSchema() {
    this.db.serialize(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS robot_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        robot_id TEXT,
        status TEXT,
        task_id TEXT,
        task_name TEXT,
        start_time TEXT,
        end_time TEXT,
        mileage TEXT,
        task_finish_count INTEGER,
        task_pause_count INTEGER,
        task_cancel_count INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    });
  }

  async saveLog(data) {
    const {
      robotId,
      status,
      currentTask = {},
      singleTaskStatistics = {},
    } = data;

    const { taskId = "N/A", taskName = "Unnamed Task" } = currentTask || {};
    const {
      cStartTime = "N/A",
      cEndTime = "N/A",
      mileage = "0",
      taskFinishCount = 0,
      taskPauseCount = 0,
      taskCancelCount = 0,
    } = singleTaskStatistics || {};

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM robot_logs WHERE 
          robot_id = ? AND 
          status = ? AND 
          task_id = ? AND 
          start_time = ? AND 
          end_time = ?`,
        [robotId, status, taskId, cStartTime, cEndTime],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (row) {
            resolve(false); // Duplicate found
            return;
          }

          this.db.run(
            `INSERT INTO robot_logs (
              robot_id, status, task_id, task_name, start_time, end_time, mileage,
              task_finish_count, task_pause_count, task_cancel_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              robotId,
              status,
              taskId,
              taskName,
              cStartTime,
              cEndTime,
              mileage,
              taskFinishCount,
              taskPauseCount,
              taskCancelCount,
            ],
            (err) => {
              if (err) reject(err);
              else resolve(true);
            }
          );
        }
      );
    });
  }
}

// Robot management
class RobotManager {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.connections = new Map();
    this.retryIntervals = new Map();
  }

  async initialize() {
    for (const robotId of this.config.robots.predefinedIds) {
      this.connectRobot(robotId); // Start connecting each robot
    }
    console.log("Robot initialization started.");
  }

  async connectRobot(robotId) {
    try {
      console.log(`Attempting to connect to robot: ${robotId}`);
      const axRobot = await this.createConnection(robotId);
      this.connections.set(robotId, axRobot);
      console.log(`Successfully connected to robot: ${robotId}`);

      // Clear retry interval if previously set
      if (this.retryIntervals.has(robotId)) {
        clearInterval(this.retryIntervals.get(robotId));
        this.retryIntervals.delete(robotId);
      }
    } catch (error) {
      console.error(`Failed to connect to robot ${robotId}:`, error);

      // Schedule reconnection attempts
      if (!this.retryIntervals.has(robotId)) {
        const retryInterval = setInterval(() => {
          console.log(`Retrying connection for robot: ${robotId}`);
          this.connectRobot(robotId);
        }, 10000); // Retry every 10 seconds
        this.retryIntervals.set(robotId, retryInterval);
      }

      // Mark as offline for now
      this.connections.set(robotId, null);
    }
  }

  async createConnection(robotId) {
    const { appId, appSecret, mode, globalServicePath, globalWsPath } =
      this.config.robots.api;

    const axRobot =
      mode === 1 || mode === "1"
        ? new AXRobotProd(
            appId,
            appSecret,
            AppModeProd.WAN_APP,
            globalServicePath,
            globalWsPath
          )
        : new AXRobotDev(appId, appSecret, AppModeDev.WAN_APP);

    const isOk = await axRobot.init();
    if (!isOk) throw new Error("Robot initialization failed");

    const resData = await axRobot.connectRobot({ robotId });
    if (resData.errCode !== 0) throw new Error(resData.errMsg);

    return axRobot;
  }

  fetchRobotData = async (robotId) => {
    const axRobot = this.connections.get(robotId);

    if (!axRobot) {
      console.warn(`Robot ${robotId} is offline or not connected.`);
      return {
        robotId,
        status: "Offline",
        currentTask: null,
        singleTaskStatistics: {},
      };
    }

    try {
      const currentTask = await this.fetchCurrentTask(axRobot);
      const singleTaskStatistics = currentTask?.taskId
        ? await this.fetchTaskStatistics(axRobot, currentTask.taskId)
        : null;

      return {
        robotId,
        status: currentTask ? "Active" : "Idle",
        currentTask: currentTask || null,
        singleTaskStatistics: singleTaskStatistics || {},
      };
    } catch (error) {
      console.error(`Error fetching data for robot ${robotId}:`, error);
      return {
        robotId,
        status: "Error",
        currentTask: null,
        singleTaskStatistics: {},
      };
    }
  };

  fetchCurrentTask = async (axRobot) => {
    try {
      return (await axRobot.getCurrentTask()) || null;
    } catch (error) {
      console.error("Error fetching current task:", error);
      return null;
    }
  };

  fetchTaskStatistics = async (axRobot, taskId) => {
    try {
      const result = await axRobot.getSingleTaskStatistics({
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
      });

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
      console.error("Error fetching task statistics:", error);
      return null;
    }
  };

  async fetchTaskStatisticsInfo(startTime, endTime, type = -1) {
    const taskStatistics = [];

    for (const [robotId, axRobot] of this.connections.entries()) {
      if (!axRobot) continue;

      try {
        const result = await axRobot.getTaskStatistics({
          startTime,
          endTime,
          type,
        });
        taskStatistics.push({ robotId, ...result });
      } catch (error) {
        console.error(
          `Error fetching task statistics for robot ${robotId}:`,
          util.inspect(error, { depth: null })
        );
      }
    }

    return taskStatistics;
  }

  destroy() {
    for (const axRobot of this.connections.values()) {
      if (axRobot) axRobot.destroy();
    }
    console.log("All robot connections destroyed.");
    for (const retryInterval of this.retryIntervals.values()) {
      clearInterval(retryInterval);
    }
    console.log("All retry intervals cleared.");
  }
}

// Express app setup
const app = express();
app.use(express.json());
app.use(cors());

// Initialize services
const database = new Database(config.database);
const robotManager = new RobotManager(config, database);

// Routes
app.get("/robots", async (req, res) => {
  const connectedRobots = config.robots.predefinedIds.filter((robotId) => {
    const robot = robotManager.connections.get(robotId);
    return robot !== null;
  });

  const results = await Promise.allSettled(
    connectedRobots.map(async (robotId) => {
      const robotData = await robotManager.fetchRobotData(robotId);
      return robotData;
    })
  );

  const formattedResults = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  res.json(formattedResults);

  formattedResults.forEach((data) => {
    database.saveLog(data).catch((err) => {
      console.error("Error saving log:", err);
    });
  });
});

app.get("/robots/:robotId", async (req, res) => {
  try {
    const { robotId } = req.params;

    if (!config.robots.predefinedIds.includes(robotId)) {
      return res.status(404).json({ error: "Robot not found" });
    }

    const axRobot = robotManager.connections.get(robotId);

    if (!axRobot) {
      return res.status(500).json({ error: "Robot not connected" });
    }

    const currentTask = await axRobot.getCurrentTask();
    const singleTaskStatistics = currentTask?.taskId
      ? await axRobot.getSingleTaskStatistics({
          taskId: currentTask.taskId,
          fields: [
            "cStartTime",
            "cEndTime",
            "mileage",
            "taskFinishCount",
            "taskPauseCount",
            "taskCancelCount",
          ],
        })
      : {};

    const startTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const endTime = Date.now();
    const type = -1;
    const taskStatistics = await axRobot.getTaskStatistics({
      startTime,
      endTime,
      type,
    });

    res.json(taskStatistics);
  } catch (error) {
    console.error("Error fetching robot details:", error);
    res.status(500).json({ error: "Failed to fetch robot details" });
  }
});

app.get("/task-statistics", async (req, res) => {
  try {
    const { startTime, endTime, type = -1 } = req.query;

    if (!startTime || !endTime) {
      return res.status(400).json({
        error: "Missing required query parameters: startTime, endTime",
      });
    }

    const taskStatistics = await robotManager.fetchTaskStatisticsInfo(
      parseInt(startTime, 10),
      parseInt(endTime, 10),
      parseInt(type, 10)
    );

    res.json(taskStatistics);
  } catch (error) {
    console.error(
      "Error fetching task statistics:",
      util.inspect(error, { depth: null })
    );
    res.status(500).json({ error: "Failed to fetch task statistics" });
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  robotManager.destroy();
  console.log("Server shutting down...");
  process.exit();
});

// Start server
async function startServer() {
  try {
    await robotManager.initialize();
    app.listen(config.port, () => {
      console.log(`Server running on http://localhost:${config.port}`);
      console.log(
        "Connected robots:",
        Array.from(robotManager.connections.keys())
      );
    });
  } catch (error) {
    console.error(
      "Failed to start server:",
      util.inspect(error, { depth: null })
    );
    process.exit(1);
  }
}

startServer();
