/**
 * This file demonstrates the process of starting WebRTC streaming using a KVS Signaling Channel.
 */
const viewer = {};
var viewer_button_pressed = new Date();
var calcInteval = 0;
var statsInteval = 0;

async function startViewer(localView, remoteView, formValues, onStatsReport, onRemoteDataMessage) {
    viewer.localView = localView;
    viewer.remoteView = remoteView;
    viewer_button_pressed = new Date();
    console.log('[WebRTC] METRICS TEST STARTED: ', viewer_button_pressed);

    // Create KVS client
    console.log("[startViewer] endpoint: ", formValues.endpoint);
    const kinesisVideoClient = new AWS.KinesisVideo({
        region: formValues.region,
        accessKeyId: formValues.accessKeyId,
        secretAccessKey: formValues.secretAccessKey,
        sessionToken: formValues.sessionToken,
        endpoint: formValues.endpoint,
        correctClockSkew: true,
    });

    // Get signaling channel ARN
    const describeSignalingChannelResponse = await kinesisVideoClient
        .describeSignalingChannel({
            ChannelName: formValues.channelName,
        })
        .promise();
    const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
    console.log('[VIEWER] Channel ARN: ', channelARN);

    // Get signaling channel endpoints
    const getSignalingChannelEndpointResponse = await kinesisVideoClient
        .getSignalingChannelEndpoint({
            ChannelARN: channelARN,
            SingleMasterChannelEndpointConfiguration: {
                Protocols: ['WSS', 'HTTPS'],
                Role: KVSWebRTC.Role.VIEWER,
            },
        })
        .promise();
    const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
        endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
        return endpoints;
    }, {});
    console.log('[VIEWER] Endpoints: ', endpointsByProtocol);

    const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
        region: formValues.region,
        accessKeyId: formValues.accessKeyId,
        secretAccessKey: formValues.secretAccessKey,
        sessionToken: formValues.sessionToken,
        endpoint: endpointsByProtocol.HTTPS,
        correctClockSkew: true,
    });

    // Get ICE server configuration
    const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
        .getIceServerConfig({
            ChannelARN: channelARN,
        })
        .promise();
    const iceServers = [];
    if (!formValues.natTraversalDisabled && !formValues.forceTURN) {
        iceServers.push({ urls: `stun:stun.kinesisvideo.${formValues.region}.amazonaws.com:443` });
    }
    if (!formValues.natTraversalDisabled) {
        getIceServerConfigResponse.IceServerList.forEach(iceServer =>
            iceServers.push({
                urls: iceServer.Uris,
                username: iceServer.Username,
                credential: iceServer.Password,
            }),
        );
    }
    console.log('[VIEWER] ICE servers: ', iceServers);

    // Create Signaling Client
    viewer.signalingClient = new KVSWebRTC.SignalingClient({
        channelARN,
        channelEndpoint: endpointsByProtocol.WSS,
        clientId: formValues.clientId,
        role: KVSWebRTC.Role.VIEWER,
        region: formValues.region,
        credentials: {
            accessKeyId: formValues.accessKeyId,
            secretAccessKey: formValues.secretAccessKey,
            sessionToken: formValues.sessionToken,
        },
        systemClockOffset: kinesisVideoClient.config.systemClockOffset,
    });

    const resolution = formValues.widescreen ? { width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 640 }, height: { ideal: 480 } };
    const constraints = {
        video: formValues.sendVideo ? resolution : false,
        audio: formValues.sendAudio,
    };
    const configuration = {
        iceServers,
        iceTransportPolicy: formValues.forceTURN ? 'relay' : 'all',
    };
    viewer.peerConnection = new RTCPeerConnection(configuration);
    if (formValues.openDataChannel) {
        viewer.dataChannel = viewer.peerConnection.createDataChannel('kvsDataChannel');
        viewer.peerConnection.ondatachannel = event => {
            event.channel.onmessage = onRemoteDataMessage;
        };
    }

    // Poll for connection stats
    viewer.peerConnectionStatsInterval = setInterval(() => viewer.peerConnection.getStats().then(onStatsReport), 1000);

    viewer.signalingClient.on('open', async () => {
        console.log('[VIEWER] Connected to signaling service');

        // Get a stream from the webcam, add it to the peer connection, and display it in the local view.
        // If no video/audio needed, no need to request for the sources. 
        // Otherwise, the browser will throw an error saying that either video or audio has to be enabled.
        if (formValues.sendVideo || formValues.sendAudio) {
            try {
                viewer.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                viewer.localStream.getTracks().forEach(track => viewer.peerConnection.addTrack(track, viewer.localStream));
                localView.srcObject = viewer.localStream;
            } catch (e) {
                console.error('[VIEWER] Could not find webcam');
                return;
            }
        }

        // Create an SDP offer to send to the master
        console.log('[VIEWER] Creating SDP offer');
        await viewer.peerConnection.setLocalDescription(
            await viewer.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            }),
        );

        // When trickle ICE is enabled, send the offer now and then send ICE candidates as they are generated. Otherwise wait on the ICE candidates.
        if (formValues.useTrickleICE) {
            console.log('[VIEWER] Sending SDP offer');
            viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
        }
        console.log('[VIEWER] Generating ICE candidates');
    });

    viewer.signalingClient.on('sdpAnswer', async answer => {
        // Add the SDP answer to the peer connection
        // console.log('[VIEWER] Received SDP answer');
        console.log('[VIEWER][ANSWER] Received SDP answer:', answer.type);
        await viewer.peerConnection.setRemoteDescription(answer);
    });

    viewer.signalingClient.on('iceCandidate', candidate => {
        // Add the ICE candidate received from the MASTER to the peer connection
        // console.log('[VIEWER] Received ICE candidate');
        console.log('[VIEWER][FROM Master] Received ICE candidate: ', JSON.stringify(candidate));
        viewer.peerConnection.addIceCandidate(candidate);
    });

    viewer.signalingClient.on('close', () => {
        console.log('[VIEWER] Disconnected from signaling channel');
    });

    viewer.signalingClient.on('error', error => {
        console.error('[VIEWER] Signaling client error: ', error);
    });

    // Send any ICE candidates to the other peer
    viewer.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
        if (candidate) {
            console.log('[VIEWER] Generated ICE candidate');

            // When trickle ICE is enabled, send the ICE candidates as they are generated.
            if (formValues.useTrickleICE) {
                console.log('[VIEWER][TRICKLE ICE Enabled] Sending ICE candidate: ', candidate.candidate);
                viewer.signalingClient.sendIceCandidate(candidate);
            }
        } else {
            console.log('[VIEWER] All ICE candidates have been generated');

            // When trickle ICE is disabled, send the offer now that all the ICE candidates have ben generated.
            if (!formValues.useTrickleICE) {
                console.log('[VIEWER][TRICKLE ICE Disabled] Sending SDP offer: ', JSON.stringify(viewer.peerConnection.localDescription));
                viewer.signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
            }
        }
    });

    // As remote tracks are received, add them to the remote view
    viewer.peerConnection.addEventListener('track', event => {
        console.log('[VIEWER] Received remote track');
        if (remoteView.srcObject) {
            return;
        }
        viewer.remoteStream = event.streams[0];
        remoteView.srcObject = viewer.remoteStream;
        console.log('[VIEWER] Start calculateStats');
        calculateStats();
    });

    console.log('[VIEWER] Starting viewer connection');
    viewer.signalingClient.open();
}

function myStopInterval() {
    clearInterval( calcInteval );
    clearInterval( statsInteval );
}

function stopViewer() {
    console.log('[VIEWER] Stopping viewer connection');
    myStopInterval();
    if (viewer.signalingClient) {
        viewer.signalingClient.close();
        viewer.signalingClient = null;
    }

    if (viewer.peerConnection) {
        viewer.peerConnection.close();
        viewer.peerConnection = null;
    }

    if (viewer.localStream) {
        viewer.localStream.getTracks().forEach(track => track.stop());
        viewer.localStream = null;
    }

    if (viewer.remoteStream) {
        viewer.remoteStream.getTracks().forEach(track => track.stop());
        viewer.remoteStream = null;
    }

    if (viewer.peerConnectionStatsInterval) {
        clearInterval(viewer.peerConnectionStatsInterval);
        viewer.peerConnectionStatsInterval = null;
    }

    if (viewer.localView) {
        viewer.localView.srcObject = null;
    }

    if (viewer.remoteView) {
        viewer.remoteView.srcObject = null;
    }

    if (viewer.dataChannel) {
        viewer.dataChannel = null;
    }
}

function sendViewerMessage(message) {
    if (viewer.dataChannel) {
        try {
            viewer.dataChannel.send(message);
        } catch (e) {
            console.error('[VIEWER] Send DataChannel: ', e.toString());
        }
    }
}

function calcDiffTimestamp2Sec(large, small) {
    var diffMs = (large - small); // milliseconds between now & Christmas
    var num = Number.parseFloat(diffMs).toFixed(2);
    var diffSec = Number.parseFloat(num / 1000).toFixed(2);
    return diffSec;
}

function calculateStats() {
    console.log("Start calculateStats...")
    video = document.getElementById("calc-stat-video");
    var decodedFrames = 0,
            droppedFrames = 0,
            decodedAudioBytes = 0;
            statStartTime = 0,
            initialTime = new Date().getTime();

    var initialDate = new Date();
    var currentDate = new Date();
    var previousDate = new Date();

    var decodedFPSArray = [];
    var droppedFramePerArray = [];
    var audioRateArray = [];
    var timeArray = [];

    //Results Param
    var connection_time = calcDiffTimestamp2Sec(initialDate.getTime(), viewer_button_pressed.getTime());
    var two_min_avg_fps = 0;
    var two_min_avg_kbps = 0;
    var two_min_avg_fd = 0
        
    const isVideoPlaying = video => !!(video.currentTime > 0 && !video.paused && !video.ended && video.readyState > 2);
    
    const chart = new Chart('metricsChart', {
        type: 'line',
        data: {
                labels: timeArray,
                datasets: [{
                    label: 'Decoded FPS',
                    borderColor: 'blue',
                    backgroundColor: 'blue',
                    fill: false,
                    data: decodedFPSArray
                },{
                    label: 'Frames Dropped (%)',
                    borderColor: 'red',
                    backgroundColor: 'red',
                    fill: false,
                    data: droppedFramePerArray
                },{
                    label: 'Audio kbps',
                    borderColor: 'orange',
                    backgroundColor: 'orange',
                    fill: false,
                    data: audioRateArray
                }]
            },
            options:{
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: 'Stream from Master'
                    },
                    legend: {
                        position: 'bottom'
                    }
                }
            }
      });


    chart.reset();

    calcInteval = window.setInterval(function(){

        //save the current values
        currentDate = new Date();
        var cur_webkitDecodedFrameCount = video.webkitDecodedFrameCount;
        var cur_webkitDroppedFrameCount = video.webkitDroppedFrameCount;
        var cur_webkitAudioDecodedByteCount = video.webkitAudioDecodedByteCount;

        //see if webkit stats are available; exit if they aren't
        if ((cur_webkitDecodedFrameCount == null)||(cur_webkitAudioDecodedByteCount == null)){
            console.log("Webkit metrics not supported on this browser. Please use Chrome.");
            return;
        //only start calculating stats once available
        } else if ((cur_webkitDecodedFrameCount > 0) || (cur_webkitAudioDecodedByteCount> 0)){
        // } else if (isVideoPlaying) {

            var currentTime = currentDate.getTime();
            var previousTime = previousDate.getTime();
            var deltaTime = (currentTime - previousTime) / 1000;
            var totalTime = (currentTime - statStartTime) / 1000;

            if (statStartTime == 0) { 
                statStartTime = currentTime;
                console.log("Measuring stream stats.");
            };  //timestamp start of decoded frames

            var int_statRunTime = parseInt(calcDiffTimestamp2Sec(currentTime, statStartTime));

            // Calculate decoded audio bytes per sec.
            var currentDecodedAudiokbps  = ((cur_webkitAudioDecodedByteCount - decodedAudioBytes) * 8) / (deltaTime * 1000);
            var decodedAudiokbpsAvg = (cur_webkitAudioDecodedByteCount * 8) / (totalTime * 1000);
            decodedAudioBytes = cur_webkitAudioDecodedByteCount;

            // Calculate decoded frames per sec.
            var currentDecodedFPS  = (cur_webkitDecodedFrameCount - decodedFrames) / deltaTime;
            var decodedFPSavg = cur_webkitDecodedFrameCount/ totalTime;
            decodedFrames = cur_webkitDecodedFrameCount;

            // Calculate dropped frames per sec.
            var currentDroppedFPS = (cur_webkitDroppedFrameCount - droppedFrames) / deltaTime;
            var droppedFPSavg = cur_webkitDroppedFrameCount / totalTime;
            droppedFrames = cur_webkitDroppedFrameCount;

            // Calculate dropped frame percentages
            var avgDropPercent = (cur_webkitDroppedFrameCount / (cur_webkitDroppedFrameCount + cur_webkitDecodedFrameCount)) * 100;
            var curDropPercent = (currentDroppedFPS / (currentDroppedFPS + currentDecodedFPS)) * 100;
            

            var html_str = "<table><tr><th>LIVE STATS</th></tr>" +
            "<tr><td></td><td>VIEWER Start:</td><td>" + viewer_button_pressed + "</td></tr>" +
            "<tr><td></td><td>TRACK Start:</td><td>" + initialDate + "</td></tr>" +
            "<tr><td></td><td>Run Time(sec):</td><td>" + int_statRunTime + "</td></tr>" +
            "<tr><td>VIDEO:</td></tr>" +
            "<tr><td></td><td>Resolution:</td><td>" + video.videoWidth + " x " + video.videoHeight + "</td></tr>" +
            "<tr><td></td><td>Avg FPS:</td><td>" + decodedFPSavg.toFixed(2) + "</td></tr>" +
            "<tr><td></td><td>Avg Frame Drop %:</td><td>" + avgDropPercent.toFixed(2) + "</td></tr>" +
            "<tr><td></td><td>Current FPS:</td><td>" + currentDecodedFPS.toFixed(2) + "</td></tr>" +
            "<tr><td></td><td>Current Frame Drop %:</td><td>" + curDropPercent.toFixed(2) + "</td></tr>" +
            "<tr><td>AUDIO:</td></tr>" +
            "<tr><td></td><td>Avg Audio kbps:</td><td>" + decodedAudiokbpsAvg.toFixed(2) + "</td></tr>" +
            "<tr><td></td><td>Current Audio kbps:</td><td>" + currentDecodedAudiokbps.toFixed(2) + "</td></tr></table>" +
            "<table><tr><th>Test Results - 2min Average</th></tr>" +
            "<tr><td>Time to P2P Connection(sec):</td><td>" + connection_time + "</td></tr>" +
            "<tr><td>Time to decoded frames(sec):</td><td>" + (calcDiffTimestamp2Sec(statStartTime, viewer_button_pressed.getTime())) + "</td></tr></table>";
            if( int_statRunTime == 120 ) {
                two_min_avg_fps = decodedFPSavg.toFixed(2);
                two_min_avg_kbps = decodedAudiokbpsAvg.toFixed(2);
                two_min_avg_fd = avgDropPercent.toFixed(2);
            }
            if( int_statRunTime >= 120 ) {
                html_str = html_str + 
                "<table><tr><td></td><td>Average Video FPS:</td><td>" + two_min_avg_fps + "</td></tr>" +
                "<tr><td></td><td>Avg Frame Drop %:</td><td>" + two_min_avg_fd + "</td></tr>" +
                "<tr><td></td><td>Average Audio kbps:</td><td>" + two_min_avg_kbps + "</td></tr></table>";
            } else {
                
                //push data to chart while avg test is running
                decodedFPSArray.push(currentDecodedFPS);
                droppedFramePerArray.push(curDropPercent);
                audioRateArray.push(currentDecodedAudiokbps);
                timeArray.push(int_statRunTime);
                chart.update();
                
                html_str = html_str + 
                "<table><tr><td></td><td><th>REMAINING RESULTS READY IN " + (120 - int_statRunTime) + " sec...</th></td></tr></table>";

            }

            //write the results to a table
            $("#webrtc-evaluation")[0].innerHTML =html_str; 

            //write the results to a table
            $("#stats")[0].innerHTML =
                    "<table><tr><th>Results</th></tr>" +
                    "<tr><td>Connection Time:</td><td>" + connection_time + "</td></tr>" +
                    "<tr><td>Frame Per Second:</td><td>" + decodedFPSavg.toFixed() + "</td></tr></table>" +
                    "<table><tr><th>TIME</th></tr>" +
                    "<tr><td>TEST  Start:</td><td>" + viewer_button_pressed + "</td></tr>" +
                    "<tr><td>TRACK Start:</td><td>" + initialTime + "</td></tr>" +
                    "<tr><td>Curr  Date</td><td>" + currentDate + "</td></tr>" +
                    "<tr><td>Curr  Time</td><td>" + currentTime + "</td></tr>" +
                    "<tr><td>Prev  Time</td><td>" + previousTime + "</td></tr>" +
                    "<tr><td>Prev  Date</td><td>" + previousDate + "</td></tr></table>" +
                    "<table><tr><th>Type</th><th>Total</th><th>Avg</th><th>Current</th></tr>" +
                    "<tr><td>Decoded</td><td>" + decodedFrames + "</td><td>" + decodedFPSavg.toFixed() + "</td><td>" + currentDecodedFPS.toFixed()+ "</td></tr>" +
                    "<tr><td>Dropped</td><td>" + droppedFrames + "</td><td>" + droppedFPSavg.toFixed() + "</td><td>" + currentDroppedFPS.toFixed() + "</td></tr>" +
                    "<tr><td>All</td><td>" + (decodedFrames + droppedFrames) + "</td><td>" + (decodedFPSavg + droppedFPSavg).toFixed() + "</td><td>" + (currentDecodedFPS + currentDroppedFPS).toFixed() + "</td></tr></table>" +
                    "Video Resolution: " + video.videoWidth + " x " + video.videoHeight; 

            previousDate = currentDate;

        } else {
            var html_str = "<table><tr><th>WAITING FOR STREAM STATS...</th></tr></table>"
            //write the results to a table
            $("#webrtc-evaluation")[0].innerHTML =html_str; 
            console.log("Waiting for stream stats...");

            previousDate = currentDate;
            return;
        }
    }, 1000);

    statsInteval = window.setInterval(function() {
        viewer.peerConnection.getStats(null).then(stats => {
            let statsOutput = "";

            stats.forEach(report => {
                if(report.type == "candidate-pair" || report.type == "remote-candidate" || report.type == "local-candidate") {
                    statsOutput += `<h2>Report: ${report.type}</h3>\n<strong>ID:</strong> ${report.id}<br>\n` +
                                `<strong>Timestamp:</strong> ${report.timestamp}<br>\n`;

                    // Now the statistics for this report; we intentially drop the ones we
                    // sorted to the top above

                    Object.keys(report).forEach(statName => {
                        if(report.type == "candidate-pair") {
                            if (statName == "transportId" || statName == "localCandidateId" || statName == "remoteCandidateId" || statName == "state") {
                                statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
                            }
                        }
                        if(report.type == "remote-candidate") {
                            if (statName == "ID" || statName == "transportId" || statName == "isRemote" || statName == "ip" || statName == "port" || statName == "protocol" || statName == "candidateType") {
                                statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
                            }
                        }
                        if(report.type == "local-candidate") {
                            if (statName == "ID" || statName == "transportId" || statName == "isRemote" || statName == "ip" || statName == "port" || statName == "protocol" || statName == "candidateType") {
                                statsOutput += `<strong>${statName}:</strong> ${report[statName]}<br>\n`;
                            }
                        }
                    });
                }
            });
            document.querySelector(".stats-box").innerHTML = statsOutput;
        });
      }, 1000);
}
