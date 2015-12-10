module.exports = Object.freeze({
  name: '',
  tasks: [
    {
      'containerDefinitions': [
        {
          'volumesFrom': [],
          'portMappings': [
            {
              'hostPort': 80,
              'containerPort': 3000,
              'protocol': 'tcp'
            }
          ],
          'command': [],
          'environment': [{
            'name': 'PASSPHRASE',
            'value': ''
          }],
          essential: true,
          entryPoint: [],
          links: [],
          mountPoints: [],
          memory: 256,
          name: 'nodebasic',
          cpu: 256,
          image: ''
        }
      ],
      'volumes': [],
      'family': 'default'
    }
  ]
});