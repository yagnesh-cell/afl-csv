const fs = require("fs");
const fetch = require("node-fetch");
require("dotenv").config();
const aws = require("aws-sdk");
const fcl = require("@onflow/fcl");
const { google } = require("googleapis");
const { SHA3 } = require("sha3");
var EC = require("elliptic").ec;
const ec = new EC("p256");
let s3;
let keyIndex = 1;
let drive;

function hash(message) {
  const sha = new SHA3(256);
  sha.update(Buffer.from(message, "hex"));
  return sha.digest();
}

async function getSignature(signable) {
  const message = signable.message;
  const key = ec.keyFromPrivate(Buffer.from(process.env.PRIVATE_KEY, "hex"));
  const sig = key.sign(hash(message)); // hashMsgHex -> hash
  const n = 32;
  const r = sig.r.toArrayLike(Buffer, "be", n);
  const s = sig.s.toArrayLike(Buffer, "be", n);
  return Buffer.concat([r, s]).toString("hex");
}

async function serverAuthorization(account) {
  const addr = `0x${process.env.ADMIN_ADDRESS}`;
  const keyId = 0;

  return {
    ...account,
    tempId: `${addr}-${keyId}`,
    addr: fcl.sansPrefix(addr),
    keyId: Number(keyId),
    signingFunction: async (signable) => {
      const signature = await getSignature(signable);
      return {
        addr: fcl.withPrefix(addr),
        keyId: Number(keyId),
        signature,
      };
    },
  };
}

const serverAuthorizationProposer = async (account, key) => {
  const addr = `0x${process.env.ADMIN_ADDRESS}`;
  const keyId = key;
  console.log(`Key Index: ${keyId}`);

  return {
    ...account,
    tempId: `${addr}-${keyId}`,
    addr: fcl.sansPrefix(addr),
    keyId: Number(keyId),
    signingFunction: async (signable) => {
      const signature = await getSignature(signable);
      return {
        addr: fcl.withPrefix(addr),
        keyId: Number(keyId),
        signature,
      };
    },
  };
};

function initialize() {
  fcl.config({
    "accessNode.api": process.env.ACCESS_NODE,
    "0xAFLAdmin": process.env.AFL_ADMIN_CONTRACT,
  });
  fs.access(`./files`, function (error) {
    if (error) {
      fs.mkdirSync(`./files`);
    }
  });
  s3 = new aws.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: "ap-southeast-2",
    signatureVersion: "v4",
  });
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/drive.photos.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  drive = google.drive({ version: "v3", auth });
}

async function downloadFile(link, folder) {
  if (!link) return;

  const url = new URL(link);
  const searchParams = url.searchParams;
  const fileId = searchParams.get("id");
  const fileName = await getFileName(link);

  await drive.files
    .get({ fileId, alt: "media" }, { responseType: "stream" })
    .then((res) => {
      return new Promise(async (resolve, reject) => {
        const filePath = `./files/${folder}/${fileName}`;
        console.log(`Writing to ${filePath}`);
        const dest = fs.createWriteStream(filePath);

        res.data
          .on("end", async () => {
            await uploadFileToS3(
              `./files/${folder}/${fileName}`,
              `starter-pack/${folder}/${fileName}`
            );
            resolve(filePath);
          })
          .on("error", (err) => {
            console.error("Error downloading file.");
            reject(err);
          })
          .pipe(dest);
      });
    });
}

async function getAWSLink(folderName, gDriveLink) {
  if (!gDriveLink) return "";
  return `${
    process.env.AWS_BASE_URL
  }/public/starter-pack/${folderName}/${await getFileName(gDriveLink)}`;
}

async function createTemplateOnBlockchain(rawObject, key) {
  const folderName = getFolderName(rawObject.headline);
  const metadata = {
    ...rawObject,
    thumbnail: await getAWSLink(folderName, rawObject.thumbnail),
    image1: await getAWSLink(folderName, rawObject.image1),
    image2: await getAWSLink(folderName, rawObject.image2),
    image3: await getAWSLink(folderName, rawObject.image3),
    packAnimation: await getAWSLink(folderName, rawObject.packAnimation),
    video: await getAWSLink(folderName, rawObject.video),
  };
  await new Promise((resolve) => setTimeout(resolve, 500));

  let res = await fcl.send([
    fcl.transaction`
      import AFLAdmin from 0xAFLAdmin
      transaction(maxSupply:UInt64) {
        prepare(acct: AuthAccount) {
          let adminRef = acct.borrow<&AFLAdmin.Admin>(from: /storage/AFLAdmin)
            ??panic("could not borrow reference")
          let immutableData : {String: AnyStruct} = {
            "thumbnail"             : "${metadata.thumbnail}",
            "image1"                : "${metadata.image1}",
            "image2"                : "${metadata.image2}",
            "image3"                : "${metadata.image3}",
            "packAnimation"         : "${metadata.packAnimation}",
            "video"                 : "${metadata.video}",
            "competition"           : "${metadata.competition}",
            "date"                  : "${metadata.date}",
            "round"                 : "${metadata.round}",
            "homeTeam"              : "${metadata.homeTeam}",
            "awayTeam"              : "${metadata.awayTeam}",
            "stadium"               : "${metadata.stadium}",
            "player"                : "${metadata.player}",
            "headline"              : "${metadata.headline}",
            "description"           : "${metadata.description}",
            "collectionName"        : "${metadata.collectionName}",
            "tier"                  : "${metadata.tier}",
            "homeTeamScore"         : "${metadata.homeTeamScore}",
            "awayTeamScore"         : "${metadata.awayTeamScore}",
            "playersJumperNumber"   : "${metadata.playersJumperNumber}",
            "teamOfInvolvedPlayer"  : "${metadata.teamOfInvolvedPlayer}",
            "highlightType"         : "${metadata.highlightType}",
            "collectionDescription" : "Get started on your Mint collection with these awesome moments from the 2022 Toyota AFL Premiership Season.",
            "collectionCount"       : "30",
            "collectionDate"        : "2023-02-22",
            "collectionLogo"        : "https://afl-mint-production.s3.ap-southeast-2.amazonaws.com/public/starter-pack/StarterPack.svg",
            "type"                  : "moment"
          }
          adminRef.createTemplate( maxSupply: maxSupply, immutableData: immutableData)
          log("Template created")
        }
      }
    `,
    fcl.args([fcl.arg("10000000", fcl.t.UInt64)]),
    fcl.payer(serverAuthorization),
    fcl.proposer((acc) => serverAuthorizationProposer(acc, key)),
    fcl.authorizations([serverAuthorization]),
    fcl.limit(1000),
  ]);
  const resultOfTx = await fcl.tx(res).onceSealed();
  const events = resultOfTx.events;
  const event = events.filter(
    (event) =>
      event.type === `A.${process.env.ADMIN_ADDRESS}.AFLNFT.TemplateCreated`
  );

  return { id: event[0].data.templateId, tier: rawObject.tier };
}

async function uploadFileToS3(fileName, target) {
  fs.readFile(fileName, async (err, data) => {
    let body = fs.createReadStream(fileName);
    if (err) throw err;

    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `public/${target}`,
      Body: body,
    };

    await s3.upload(params).promise();
  });
}

async function getFileName(rawLink) {
  const url = new URL(rawLink);
  if (url) {
    const searchParams = url.searchParams;
    const fileId = searchParams.get("id");
    const res = await drive.files.get({ fileId });
    return res.data.name;
  }
}

function getFolderName(headline) {
  return headline.replace(/ /g, "-");
}

function readCSV() {
  const fileName = process.argv[2];
  const rawData = fs.readFileSync(`./${fileName}`, "utf8");
  return rawData.split("\r\n");
}

function createIndividualFolder(folderName) {
  fs.access(`./files/${folderName}`, function (error) {
    if (error) {
      fs.mkdirSync(`./files/${folderName}`);
    }
  });
}

async function downloadMediaFiles(rawObject) {
  const folderName = getFolderName(rawObject.headline);
  await downloadFile(rawObject.thumbnail, folderName);
  await downloadFile(rawObject.image1, folderName);
  await downloadFile(rawObject.image2, folderName);
  await downloadFile(rawObject.image3, folderName);
  await downloadFile(rawObject.packAnimation, folderName);
  await downloadFile(rawObject.video, folderName);
}

function generateMetadata(rawNFT) {
  const row = rawNFT.split("\t");
  return {
    thumbnail: row[0],
    image1: row[1],
    image2: row[2],
    image3: row[3],
    packAnimation: row[4],
    video: row[5],
    competition: row[6],
    date: row[7],
    round: row[8],
    homeTeam: row[9],
    awayTeam: row[10],
    stadium: row[11],
    player: row[12],
    headline: row[13],
    description: row[14],
    collectionName: row[15],
    tier: row[16],
    homeTeamScore: row[17],
    awayTeamScore: row[18],
    playersJumperNumber: row[19],
    teamOfInvolvedPlayer: row[20],
    highlightType: row[21],
  };
}

async function start() {
  initialize();
  const rawNFTs = readCSV();
  const promises = [];
  for (const rawNFT of rawNFTs) {
    const rawObject = generateMetadata(rawNFT);
    console.log(`Processing ${rawObject.headline}`);
    createIndividualFolder(getFolderName(rawObject.headline));
    await downloadMediaFiles(rawObject);
    // await new Promise((resolve) => setTimeout(resolve, 700));
    // promises.push(createTemplateOnBlockchain(rawObject, keyIndex));
    keyIndex++;
  }
  Promise.all(promises).then((values) => {
    console.log(values.length);
    console.log(JSON.stringify(values));
  });
}

start();
