import { LambdaClient, TagResourceCommand, ListTagsCommand } from "@aws-sdk/client-lambda";
import axios from 'axios';
import * as https from 'https';

const pullingSources = [
    'https://service.cbs.tw/public/upload/files/json/{year}_earthquakeew.json',
];

const LAMBDA_ARN = process.env.LAMBDA_ARN;

const TYPE_PREFIX = 'alertType_';

let _httpsClient = null;
let _lambdaClient = null;

async function fetchAlarmLatestUpdate(lambdaClient) {
    const command = new ListTagsCommand({
        Resource: LAMBDA_ARN,
    });

    const response = await lambdaClient.send(command);
    let result = {};

    for(let k in response.Tags) {
        if(k.startsWith(TYPE_PREFIX)) {
            result[k] = response.Tags[k];
        }
    }

    return result;
}

function formatAlarm(am) {
    let url = 'https://cbs.tw/' + (am.release_time.replace(/\D/g, '').substr(2, 4)) + am.page_key;

    let message = am.CMAMtext;
    message += '\n---\n';
    message += url;

    return message;
}

function isTestMessage(message) {
    return !!message.match(/(演練|演習)/ig);
}

function getHttpsClient() {
    if(_httpsClient === null) {
        _httpsClient = axios.create({
            httpsAgent: new https.Agent({keepAlive: true}),
            headers: {
                'accept': 'application/json',
            },
        });
    }
    return _httpsClient;
}

function getLambdaClient() {
    if(_lambdaClient === null) {
        _lambdaClient = new LambdaClient();
    }
    return _lambdaClient;
}

export const handler = async (event) => {
    // console.log(JSON.stringify(event));
    const httpsClient = getHttpsClient();
    const lambdaClient = getLambdaClient();

    let today = new Date().toLocaleString('zh-TW', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: 'Asia/Taipei',
    });
    let year = today.substr(0, 4);
    let sourceType = [];
    for(let i = 0, j = pullingSources.length; i < j; i++) {
        let s = pullingSources[i] = pullingSources[i].replace('{year}', year);
        let sourceMatch = s.match(/\/\d+_(\w+)\.json/);
        if(sourceMatch.length >= 2) {
            sourceType[i] = sourceMatch[1];
        }
    }

    let promises = [];
    for(let i = 0, j = pullingSources.length; i < j; i++) {
        let src = pullingSources[i];
        promises.push(axios.get(src).then(r => {
            if(r.headers.get('content-type') === 'application/json' && r.data.success === true) {
                return r.data.data.alertMessages.sort((a, b) => {
                    return a.release_time.localeCompare(b.release_time)
                });
            }
            return null;
        }).catch(console.error));
    }

    let latestTimeMap = await fetchAlarmLatestUpdate(lambdaClient);
    let results = await Promise.all(promises);
    let newAlarms = [];
    let tagUpdate = {};

    for(let i = 0, j = pullingSources.length; i < j; i++) {
        let result = results[i];
        let type = sourceType[i] || '';
        if(!result) continue;
        let key = TYPE_PREFIX + type;
        let latestTime = latestTimeMap[key] || '';

        result.forEach(r => {
            if(latestTime.localeCompare(r.release_time) < 0 && !isTestMessage(r.CMAMtext)) {
                newAlarms.push(r);
                tagUpdate[key] = r.release_time;
            }
        });
    }

    let postPromises = [];

    if(Object.keys(tagUpdate).length > 0) {        
        let updateTagCommand = new TagResourceCommand({
            Resource: LAMBDA_ARN,
            Tags: tagUpdate,
        });
        postPromises.push(lambdaClient.send(updateTagCommand));
    }

    // post to channel
    if(process.env.SLACK_WEBHOOKS) {        
        let webhooks = process.env.SLACK_WEBHOOKS.split(',');
        newAlarms.forEach(am => {
            let formattedMessage = formatAlarm(am);
            webhooks.forEach(webhook => {                
                postPromises.push(httpsClient.post(
                    webhook, {
                        text: formattedMessage,
                    }
                ));
            });
        })
    }

    await Promise.all(postPromises);

    const response = {
        statusCode: 204,
        body: '',
    };
    return response;
};
