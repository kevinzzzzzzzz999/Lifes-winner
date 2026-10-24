'use strict';
const {MICROPHONE_USAGE_DESCRIPTION}=require('../../src/main/ai-media-permissions.cjs');
const macInfoPlist=Object.freeze({NSMicrophoneUsageDescription:MICROPHONE_USAGE_DESCRIPTION});
module.exports={macInfoPlist};
