require('log-timestamp');

var http = require('https');
var config = require('./config');
var Firebase = require('firebase');

var tasksRef = new Firebase(config.TasksFirebaseURL);
var queuesRef = new Firebase(config.QueuesFirebaseURL);
var usersRef = new Firebase(config.UsersFirebaseURL);

var managedQueues = [];
var delayedServices = [];

function taskSendSMS(number, message)
{
	var options = {
	  host: 'api.clockworksms.com',
	  path: '/http/send.aspx?key=' + config.ClockworkSMSKey + '&to=' + number + '&content=' + message
	};

	callback = function(response) {
	  var str = '';

	  //another chunk of data has been recieved, so append it to `str`
	  response.on('data', function (chunk) {
		str += chunk;
	  });

	  //the whole response has been recieved, so we just print it out here
	  response.on('end', function () {
		console.log(str);
	  });
	}

	http.request(options, callback).end();
}

function setStatus(userRef, state)
{
	userRef.child('status').set(state);
}

function getUserRef(userId)
{
	return usersRef.child(userId).ref();
}

function sendSMS(userRef, message)
{
	 userRef.once('value', function(sendSMSSnapshot) {
	 	user = sendSMSSnapshot.val();

	 	if(user.mobile && !user.mobile.indexOf("4455") == 0)
	 	{
	 		addTask('sms', { mobile: user.mobile, message: encodeURIComponent(message) });
	 	}
	 	else
	 	{
	 		console.log("User " + user.fullName + " has no mobile or has a test number so we won't try sending an SMS");
	 	}
	 });	 
}

function addTask(type, payload)
{
	//console.dir(type);
	//console.dir(payload);

	tasksRef.push({ task: type, payload: payload });
}

function handleQueuedUser(handleUserSnapShot)
{
	var item = handleUserSnapShot.val();

	//Get parent queueId
	var parentQueue = handleUserSnapShot.ref().parent().ref().parent();

	parentQueue.child('messages').ref().once('value', function(messagesSnapshot) {
		messages = messagesSnapshot.val();

		switch(item.status)
		{
			case 'joined':
				sendSMS(getUserRef(item.userId), messages.joined);

				setStatus(handleUserSnapShot.ref(), 'waiting');

				break;
			case 'servicing':
				if(!item.processedServicing)
				{
					sendSMS(getUserRef(item.userId), messages.servicing);

					parentQueue.ref().once('value', function(queueSnapshot) {
						if(queueSnapshot.val().type == 'automated')
						{
							console.log(item.processed)

							
							console.log("Scheduling delayed Service");

							var t = new Date();
							t.setSeconds(t.getSeconds() + queueSnapshot.val().serviceTime);

							//This was an attempt to fix the annoying GMT/BST bug at 1:30am the first time round. It failed.
							//var t = new Date(t.valueOf() - t.getTimezoneOffset() * 60000);

							payload = { queue: queueSnapshot.name(), 
										user: item.userId,
										dequeueTime: t.toISOString()
							};

							addTask('delayedService', payload);

							handleUserSnapShot.ref().child('processedServicing').set(true);
							
						}
					});
				}	
				break;
			case 'serviced':
				sendSMS(getUserRef(item.userId), messages.serviced);
				handleUserSnapShot.ref().remove();
				break;
			case 'holding':
				if(!item.processedHold)
				{
					sendSMS(getUserRef(item.userId), messages.holding);
					handleUserSnapShot.ref().child('processedHold').set(true);
				}				
				break;
			case 'waiting':
				//If moving into waiting clean up any state specific locks
				if(item.processedHold)
				{
					handleUserSnapShot.ref().child('processedHold').ref().remove();
				}
				if(item.processedServicing)
				{
					handleUserSnapShot.ref().child('processedServicing').ref().remove();
				}
				break;
		}	

		
	});

	
}

function handleUser(handleUserSnapShot)
{
	user = handleUserSnapShot.val();

	if(user.fullName == 'Anonymous')
	{
		if(!user.registrationTextSent)
		{
			console.log("Anonymous user detected. Sending registration text");
			sendSMS(handleUserSnapShot.ref(), "Thanks for using qcue.me. Unfortunately we don't know who you are. Reply with NAME your name to register yourself.");
			handleUserSnapShot.ref().child('registrationTextSent').set(true);
		}
	}

	if(user.status == 'registered')
	{
		console.log(user.fullName + 'has now registered. Sending confirmation message.');
		sendSMS(handleUserSnapShot.ref(), "Thanks for registering for qcue.me. We won't bother you anymore with such trivial questions.");
		handleUserSnapShot.ref().child('status').remove();
	}
}

console.log("Worker initialising")

tasksRef.on('child_added', function(snapshot) {
  //console.log(snapshot)

  item = snapshot.val();

  var processed = item.processed, task = item.task, payload = item.payload;
  if(!processed)
  {
	switch(task)
	{
		case 'sms':
			console.log('Received SMS task. Number: ' + payload.mobile);
			taskSendSMS(payload.mobile, payload.message)
			snapshot.ref().remove();
			break;
		case 'delayedService':
			console.log('Loading delayedService into memory for processing when required');
			delayedServices.push(snapshot);
			break;
		default:
			console.log('Unknown task: ' + task);
			break;

		
	}

	
  }
  
});

queuesRef.on('child_added', function(snapshot) {
	item = snapshot.val();

	if(item.type == 'automated')
	{
		console.log('Found automated queue ' + item.name + '. Monitoring.')

		managedQueues.push({queue: snapshot.ref(), timer: item.gap, lastChecked: new Date()});
	}

	//Add event to queue to monitor for changes to users in queue.

	console.log('Monitoring for user changes for queue ' + item.name + '.')

	users = snapshot.child('users');

	users.ref().on('child_changed', function(snapshot) {
		item = snapshot.val();

		handleQueuedUser(snapshot);
	});

	users.ref().on('child_added', function(snapshot) {
		item = snapshot.val();

		handleQueuedUser(snapshot);
	});

});

usersRef.on('child_added', function(childSnapshot) {
	handleUser(childSnapshot);
});

usersRef.on('child_changed', function(childSnapshot) {
	handleUser(childSnapshot);
});

setInterval(function() {
	//console.log("Checking automated queues")

	//PROCESS QUEUES
	var length = managedQueues.length,
		element = null;
	for (var i = 0; i < length; i++)
	{
		element = managedQueues[i];
	  
		//console.log(element);

		var now = new Date();
		var diffTime = now.getTime() - element.lastChecked.getTime();

		//console.log(diffTime);

		if(diffTime > element.timer * 1000)
		{
			//Mark last checked as now
			element.lastChecked = now;

			//Get the item from firebase
			element.queue.once('value', function(snapshot) {

				item = snapshot.val();

				startDate = new Date(item.queueStart);

				if(startDate < new Date())
				{
					console.log("Processing queue: " + item.name);
				}
				else
				{
					console.log("Queue not started: " + item.name);
				}

				//DO STUFF

				//Update local timer cache
				element.timer = item.gap;
			});

		}
	}


	//PROCESS DELAYEDSERVICE
	length = delayedServices.length,
		element = null;
	for (var i = 0; i < length; i++)
	{
		element = delayedServices[i].val();

		//console.dir(element)

		dequeue = new Date(element.payload.dequeueTime)

		//console.log(dequeue)

		if(dequeue < new Date())
		{
			userItem = queuesRef.child(element.payload.queue).child('users').ref().once('value', function(delServiceSnapshot){
				delServiceSnapshot.forEach(function(userItemSnapshot){
					userItem = userItemSnapshot.val();

					if(userItem.userId == element.payload.user)
					{
						console.log('Servicing as a result of delayed service');
						setStatus(userItemSnapshot.ref(), 'serviced');
					}
				});

				//We process these outside the loop in order to quietly tidyup incase duplicates get added
				//Delete from firebase
				delayedServices[i].ref().remove();

				//Remove from array
				delayedServices.splice(i, 1);
			});
		}

	}

}, 1000)

console.log("Worker initialised");