try {
  require('./config');
} catch (e) {
  console.log("Error: You must have a configuration file in server path! [config.json]");
  process.exit();
}
const config = require('./config');
const fs = require('fs');
const util = require('util');
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);
const cors = require('cors');
const path = require('path');
const sanitize = require("sanitize-filename");
const disk = require('diskusage');
const chokidar = require('chokidar');
const sqlite3 = require('sqlite3')
const dayjs = require('dayjs');
const wavFileInfo = require('wav-file-info');
const infoByFilename = util.promisify(wavFileInfo.infoByFilename);

const express = require('express');
const app = express();
const default_port = 8080;
const NodeCache = require("node-cache");
const fileCache = new NodeCache({stdTTL: 10});

app.use(cors());
app.use(express.urlencoded({extended: true}));
app.use(express.json());

// handle values from config file
let wavDir;
wavDir = config.wavDir;
if (!wavDir) {
  console.log("Error: You must have a wavDir set in config file!");
  process.exit();
}

let archiveDir;
archiveDir = config.archiveDir;
if (!archiveDir) {
  console.log("Error: You must have a archiveDir set in config file!");
  process.exit();
}

let port = config.port;
if (!port) {
  port = default_port;
}

let db_path = config.db_path;
if (!db_path) {
  db_path = "./db.v1.sqlite";
}

let minCallLength = config.minCallLength;
if (!minCallLength) {
  minCallLength = 3.5;
}

// create the sqlite database
const DB = new sqlite3.Database(db_path, err => {
  if (err) {
    console.log(err);
    process.exit();
  }
  console.log(`Connected to ${db_path} database.`)
});
DB.get("SELECT name FROM sqlite_master WHERE type='table' AND name='calls';", (err, row) => {
  if (!row) {
    DB.exec(
      `CREATE TABLE calls (
        id integer NOT NULL PRIMARY KEY,
        freq text NOT NULL,
        time integer NOT NULL,
        duration numeric NOT NULL,
        size integer NOT NULL,
        relative_path text NOT NULL UNIQUE
      );`, function(err) {
      if (err) {
        console.log(err);
        console.log("cannot create calls table");
        process.exit();
      }
      // repopulate the database here
      async function walk(dir) {
        const subdirs = await readdir(dir);
        console.log(subdirs);
        const files = await Promise.all(subdirs.map(async (subdir) => {
          const res = path.join(dir, subdir);
          return (await stat(res)).isDirectory() ? walk(res) : await archive_call(res);
        }));
      }
      console.log(`Scanning ${archiveDir} to populate fresh database`);
      walk(archiveDir);
    });
  }
});

// archive valid WAV files from ham2mon and store them in the database
async function archive_call(path) {
  const pathComponents = path.split('/');
  const fileName = pathComponents[pathComponents.length-1];
  const [freq, time] = fileName.slice(0, -4).split('_');
  // determine if we're dealing with a valid WAV
  let wav_info;
  let duration;
  try {
    wav_info = await infoByFilename(path);
    duration = wav_info.stats.size / wav_info.header.byte_rate;
    if (duration < minCallLength) {
      console.log(`deleting ${path}: duration too short`, wav_info);
      try {
        fs.unlinkSync(path);
      } catch (err) {
        console.log(err);
      }
      return;
    }
  } catch (err) {
    console.log(`deleting ${path}: ${JSON.stringify(err)}`);
    try {
      fs.unlinkSync(path);
    } catch (err) {
      console.log(err);
    }
    return;
  }

  // maybe move the wav to the appropriate location
  const archive_subdir = `${dayjs(time * 1000).format('YYYY/MM/DD')}`;
  const relative_path = `${archive_subdir}/${fileName}`;
  const target_path = `${archiveDir}/${relative_path}`;
  await mkdir(`${archiveDir}/${archive_subdir}`, { recursive: true });
  // when repopulating the database, the path and target_path will be the same
  if (path != target_path) {
    await rename(path, target_path);
    console.log(`Moved ${path} to ${target_path}`);
  }
  DB.run(
    `INSERT INTO calls (freq, time, duration, size, relative_path)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(relative_path) DO UPDATE SET duration = ?, size = ?;`,
    [freq, time, duration, wav_info.stats.size, relative_path, duration, wav_info.stats.size],
    err => {
      if (err) {
        console.log(err);
        return;
      }
  });
}

async function rescan(dir) {
  const files = fs.readdir(dir, (err, files) => {
    if (files) {
      files.map(file => {
        archive_call(`${wavDir}/${file}`);
      });
    }
  });
}

rescan(wavDir);

// start watching the wavDir
const watcher = chokidar.watch(wavDir, {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 200
  },
});
watcher.on('add', async path => {
  console.log(`File ${path} has been added`);
  await archive_call(path);
});

async function queryCalls(freq, afterTime, beforeTime) {
  return new Promise((resolve, reject) => {
    let query = "SELECT freq, time, duration, size, relative_path as file FROM calls";
    let conditions = [];
    let values = [];
    if (freq) {
      conditions[conditions.length] = "(freq = ?)";
      values[values.length] = freq;
    }
    if (afterTime) {
      conditions[conditions.length] = "(time > ?)";
      values[values.length] = afterTime;
    }
    if (beforeTime) {
      conditions[conditions.length] = "(time < ?)";
      values[values.length] = beforeTime;
    }
    if (conditions.length > 0) {
      query = `${query} WHERE ${conditions.join(' AND ')}`;
    }
    query = `${query} ORDER BY time ASC`;
    DB.all(query, values, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function queryCallSize() {
  return new Promise((resolve, reject) => {
    DB.get("SELECT SUM(size) as total_size FROM calls", (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row.total_size);
      }
    });
  });
}

setInterval(rescan.bind(this, wavDir), 20000);

app.post('/data', async (req, res) => {
  const dirSize = await queryCallSize();
  let availableSpace = fileCache.get('availableSpace');

  if (availableSpace === undefined) {
    const result = await disk.check(wavDir);
    availableSpace = result.available;
    fileCache.set('availableSpace', availableSpace, 60 * 60);
  }

  const {freq, afterTime, beforeTime, fromTime} = req.body;
  if (fromTime) {
    // don't spam the logs
    // console.log("fromTime is deprecated, use afterTime instead");
  }
  res.json({
    files: await queryCalls(freq, fromTime ? fromTime : afterTime, beforeTime),
    dirSize,
    freeSpace: availableSpace
  });
});

function deleteFiles(files) {
  for (let file of files) {
    DB.get("SELECT id FROM calls WHERE relative_path = ?", [file], (err, row) => {
      if (err) {
        console.log(`ERROR: ${file} is not in the database, cannot delete`);
        return;
      }
      try {
        fs.unlinkSync(archiveDir + "/" + file);
        DB.run("DELETE FROM calls WHERE id = ?", [row.id], (err) => {
          if (err) {
            console.log(`Error removing call ${file} (${row.id}) from database`, e);
            return;
          }
          console.log("Deleted " + file);
        });
      } catch (e) {
        console.log("Error deleting file " + file, e);
      }
    });
  }
}

app.post('/deleteBefore', async (req, res) => {
  const {deleteBeforeTime} = req.body;

  const filesToDelete = (await queryCalls(undefined, undefined, deleteBeforeTime))
    .map(file => file.file);

  deleteFiles(filesToDelete);

  fileCache.del('dirSize');
  fileCache.del('availableSpace');

  res.json({});
});

app.post('/delete', async (req, res) => {
  const {files} = req.body;

  deleteFiles(files);

  res.json({});
});

app.use('/static', express.static(archiveDir));
app.use('/', express.static(path.join(__dirname, '../build')));

app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`));
