require('log-timestamp');

var http = require('https');
var config = require('./config');
var Firebase = require('firebase');

var tasksRef = new Firebase(config.TasksFirebaseURL);
var queuesRef = new Firebase(config.QueuesFirebaseURL);
var usersRef = new Firebase(config.UsersFirebaseURL);

var managedQueues = [];

function SendSMS(number, message)
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

	 	if(user.mobile && user.mobile != '4477123456789')
	 	{
	 		addTask('sms', { mobile: user.mobile, message: encodeURIComponent(message) });
	 	}
	 	else
	 	{
	 		console.log("User " + user.fullName + " has no mobile so we won't try sending an SMS");
	 	}
	 });	 
}

function addTask(type, payload)
{
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
				sendSMS(getUserRef(item.userId), messages.servicing);
				break;
			case 'serviced':
				sendSMS(getUserRef(item.userId), messages.serviced);
				handleUserSnapShot.ref().remove();
				break;
			case 'holding':
				sendSMS(getUserRef(item.userId), messages.holding);
				break;
		}	

		
	});

	
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
			SendSMS(payload.mobile, payload.message)
			break;
		default:
			console.log('Unknown task: ' + task);
			break;

		
	}

	snapshot.ref().remove();
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
	user = childSnapshot.val();

	if(user.fullName == 'Anonymous')
	{
		if(!user.registrationTextSent)
		{
			console.log("Anonymous user detected. Sending registration text");
			sendSMS(childSnapshot.ref(), "Thanks for using qcue.me - unfortunately we don't know who you are. Reply with NAME your name to register yourself.");
			childSnapshot.ref().child('registrationTextSent').set(true);
		}
	}
});

setInterval(function() {
	//console.log("Checking automated queues")

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
}, 1000)

console.log("Worker initialised");