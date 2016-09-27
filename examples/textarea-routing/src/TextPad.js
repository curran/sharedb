// This component encapsulates sharedb-string-binding as a React component.
//
// Derived from the original ShareDB textarea example found at
// https://github.com/share/sharedb/blob/master/examples/textarea/client.js

import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import StringBinding from 'sharedb-string-binding';
import connection from './connection';
import './TextPad.css';

function createIfNeeded(doc, callback){
  if(doc.type === null){
    doc.create('', callback);
  } else {
    callback();
  }
}

class TextPad extends Component {

  componentDidMount() {

    // Get a reference to the textArea DOM node.
    const textArea = ReactDOM.findDOMNode(this.refs.textArea);

    // Create local Doc instance mapped to 'examples' collection document
    // with id derived from this.props.docId
    const doc = connection.get('examples', this.props.docId);

    doc.subscribe((err) => {
      if (err) throw err;
      createIfNeeded(doc, () => {
        const binding = new StringBinding(textArea, doc);
        binding.setup();
      });
    });

    this.doc = doc;
  }

  componentWillUnmount() {
    this.doc.destroy();
  }

  render() {
    return <textarea className="TextPad" ref="textArea" />
  }
}

export default TextPad;
